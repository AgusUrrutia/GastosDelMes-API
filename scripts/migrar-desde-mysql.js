// Copia todos los datos de la base MySQL de XAMPP (gastos_mes) a MongoDB.
// Uso: npm run migrar             (falla si Mongo ya tiene usuarios)
//      npm run migrar -- --reemplazar   (borra lo que haya en Mongo y vuelve a copiar)
// Lee MONGODB_URI / MONGODB_DB del archivo .env y MYSQL_* (por defecto root sin
// contraseña en 127.0.0.1, base gastos_mes).
const mysql = require('mysql2/promise');
const { MongoClient, ObjectId } = require('mongodb');

const ZONA = 'America/Argentina/Buenos_Aires';
const fechaLocal = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(d);
const COLECCIONES = ['parejas', 'usuarios', 'sesiones', 'puntos', 'meses', 'gastos', 'cuotas', 'cuotas_pagadas', 'intentos_login'];

async function main() {
  const reemplazar = process.argv.includes('--reemplazar');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI en .env');

  const my = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'gastos_mes',
    decimalNumbers: true,
  });
  const cliente = await MongoClient.connect(process.env.MONGODB_URI);
  const db = cliente.db(process.env.MONGODB_DB || 'gastos_mes');

  try {
    if (await db.collection('usuarios').countDocuments() > 0) {
      if (!reemplazar) throw new Error('Mongo ya tiene datos. Para borrarlos y copiar de nuevo: npm run migrar -- --reemplazar');
      for (const c of COLECCIONES) await db.collection(c).deleteMany({});
    }

    const filas = async (sql) => (await my.query(sql))[0];
    // Cada id numérico de MySQL pasa a un ObjectId nuevo; se guarda la equivalencia
    const mapa = (lista) => new Map(lista.map((f) => [f.id, new ObjectId()]));
    const ref = (m, id) => (id == null ? null : m.get(id) ?? null);

    const parejas = await filas('SELECT * FROM parejas');
    const usuarios = await filas('SELECT * FROM usuarios');
    const puntos = await filas('SELECT * FROM puntos ORDER BY id');
    const meses = await filas('SELECT * FROM meses');
    const gastos = await filas('SELECT * FROM gastos');
    const cuotas = await filas('SELECT * FROM cuotas');
    const pagadas = await filas('SELECT * FROM cuotas_pagadas');

    const idPareja = mapa(parejas);
    const idUsuario = mapa(usuarios);
    const idMes = mapa(meses);
    const idCuota = mapa(cuotas);
    const hoy = fechaLocal(new Date());

    const insertar = async (coleccion, docs) => {
      if (docs.length) await db.collection(coleccion).insertMany(docs);
      console.log(`${coleccion}: ${docs.length}`);
    };

    await insertar('parejas', parejas.map((p) => ({ _id: idPareja.get(p.id), nombre: p.nombre })));

    await insertar('usuarios', usuarios.map((u) => {
      const propios = puntos.filter((p) => p.usuario_id === u.id);
      const caricias = propios.filter((p) => p.tipo === 'caricia');
      const cariciasHoy = caricias.filter((p) => fechaLocal(p.fecha) === hoy);
      return {
        _id: idUsuario.get(u.id),
        pareja_id: idPareja.get(u.pareja_id),
        usuario: u.usuario,
        nombre: u.nombre,
        password_hash: u.password_hash,
        puntos: u.puntos,
        ingresos: propios.filter((p) => p.tipo === 'ingreso').length,
        caricias: caricias.length,
        caricias_dia: hoy,
        caricias_hoy: cariciasHoy.length,
        caricia_ultima: caricias.length ? caricias[caricias.length - 1].fecha : null,
        creado: u.creado,
      };
    }));

    await insertar('puntos', puntos.map((p) => ({
      usuario_id: idUsuario.get(p.usuario_id), tipo: p.tipo, puntos: p.puntos, fecha: p.fecha,
    })));

    await insertar('meses', meses.map((m) => ({
      _id: idMes.get(m.id), pareja_id: idPareja.get(m.pareja_id), anio: m.anio, mes: m.mes,
      idx: m.anio * 12 + m.mes, ingreso: m.ingreso, ahorro: m.ahorro,
    })));

    await insertar('gastos', gastos.map((g) => ({
      mes_id: idMes.get(g.mes_id), categoria: g.categoria, detalle: g.detalle, maximo: g.maximo,
      gastado: g.gastado, pagado: g.pagado, nota: g.nota, orden: g.orden,
      creado_por: ref(idUsuario, g.creado_por), pagado_por: ref(idUsuario, g.pagado_por),
    })));

    await insertar('cuotas', cuotas.map((c) => ({
      _id: idCuota.get(c.id), pareja_id: idPareja.get(c.pareja_id), detalle: c.detalle,
      monto_cuota: c.monto_cuota, total_cuotas: c.total_cuotas, anio_inicio: c.anio_inicio, mes_inicio: c.mes_inicio,
    })));

    await insertar('cuotas_pagadas', pagadas.map((p) => ({
      cuota_id: idCuota.get(p.cuota_id), anio: p.anio, mes: p.mes, idx: p.anio * 12 + p.mes,
      pagado_por: ref(idUsuario, p.pagado_por),
    })));

    console.log('Migración terminada. Las sesiones no se copian: hay que volver a ingresar.');
  } finally {
    await my.end();
    await cliente.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
