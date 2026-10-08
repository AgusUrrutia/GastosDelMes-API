// API JSON de la app (Node + MongoDB). Todas las llamadas: /api?action=<accion>
// Salvo "login", todas requieren el header X-Token con el token de la sesión.
// Responde lo mismo que la versión PHP anterior, así la web y la app no cambian.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { getDb } = require('../lib/db');

// Puntos que suma cada acción
const PUNTOS_INGRESO = 10;
const PUNTOS_CARICIA = 1;

// Límites de caricias por usuario
const CARICIA_ESPERA_SEG = 60;  // espera mínima entre dos caricias
const CARICIAS_POR_DIA = 20;    // máximo de caricias por día

// Bloqueo de ingreso tras varios intentos fallidos desde la misma IP
const LOGIN_MAX_FALLOS = 5;
const LOGIN_BLOQUEO_MIN = 15;

// "Hoy" se cuenta en hora de Argentina, aunque el servidor esté en otra zona
const ZONA = 'America/Argentina/Buenos_Aires';
const fechaLocal = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(d);

const CATEGORIAS = ['fijo', 'variable', 'extra'];

// Error con código HTTP; se convierte en {"error": ...}
class Fallo extends Error {
  constructor(mensaje, status = 400, extra = {}) { super(mensaje); this.status = status; this.extra = extra; }
}
const fallar = (mensaje, status, extra) => { throw new Fallo(mensaje, status, extra); };

// ---------- Validación y formato ----------

function entero(v, campo) {
  if (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) fallar(`Valor inválido para ${campo}`);
  return Math.trunc(Number(v));
}

function monto(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (Number.isNaN(Number(v))) fallar('Monto inválido');
  return Math.round(Number(v) * 100) / 100;
}

const texto = (v, max) => String(v ?? '').trim().slice(0, max);

function oid(v, campo = 'id') {
  if (!ObjectId.isValid(String(v ?? ''))) fallar(`Valor inválido para ${campo}`);
  return new ObjectId(String(v));
}

// Documento de Mongo → objeto para el cliente (_id → id, ObjectId → texto)
function salida(doc) {
  if (!doc) return null;
  const r = {};
  for (const [k, v] of Object.entries(doc)) {
    r[k === '_id' ? 'id' : k] = v instanceof ObjectId ? v.toString() : v;
  }
  return r;
}

const indiceMes = (anio, mes) => anio * 12 + mes;

// ---------- Sesión y puntos ----------

async function usuarioActual(db, req) {
  const token = String(req.headers['x-token'] || '');
  if (!/^[a-f0-9]{64}$/.test(token)) fallar('Sesión no iniciada', 401);
  const sesion = await db.collection('sesiones').findOneAndUpdate(
    { _id: token }, { $set: { ultimo_uso: new Date() } },
  );
  if (!sesion) fallar('La sesión expiró, volvé a ingresar', 401);
  const u = await db.collection('usuarios').findOne({ _id: sesion.usuario_id });
  if (!u) fallar('La sesión expiró, volvé a ingresar', 401);
  return { ...u, token };
}

async function sumarIngreso(db, usuarioId) {
  await db.collection('usuarios').updateOne({ _id: usuarioId }, { $inc: { puntos: PUNTOS_INGRESO, ingresos: 1 } });
  await db.collection('puntos').insertOne({ usuario_id: usuarioId, tipo: 'ingreso', puntos: PUNTOS_INGRESO, fecha: new Date() });
}

// Cuántas caricias le quedan hoy a un usuario y cuántos segundos falta para la próxima
function estadoCaricias(u) {
  const hoy = u.caricias_dia === fechaLocal() ? (u.caricias_hoy || 0) : 0;
  const pasados = u.caricia_ultima ? Math.floor((Date.now() - u.caricia_ultima.getTime()) / 1000) : Infinity;
  const restantes = Math.max(0, CARICIAS_POR_DIA - hoy);
  return {
    hoy,
    limite_dia: CARICIAS_POR_DIA,
    restantes,
    espera: restantes === 0 ? 0 : Math.max(0, CARICIA_ESPERA_SEG - pasados),
  };
}

// Integrantes de la pareja con sus puntos, ordenados de mayor a menor
async function ranking(db, parejaId) {
  const hoy = fechaLocal();
  const usuarios = await db.collection('usuarios')
    .find({ pareja_id: parejaId })
    .sort({ puntos: -1, nombre: 1 })
    .toArray();
  return usuarios.map((u) => ({
    id: u._id.toString(),
    nombre: u.nombre,
    puntos: u.puntos || 0,
    ingresos: u.ingresos || 0,
    caricias: u.caricias || 0,
    caricias_hoy: u.caricias_dia === hoy ? (u.caricias_hoy || 0) : 0,
  }));
}

const datosUsuario = (u) => ({ id: u._id.toString(), usuario: u.usuario, nombre: u.nombre });

function ipCliente(req) {
  const reenviada = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (reenviada || req.socket?.remoteAddress || 'desconocida').slice(0, 45);
}

// ---------- Validación de pertenencia a la pareja ----------

async function mesDeLaPareja(db, mesId, parejaId) {
  const m = await db.collection('meses').findOne({ _id: mesId, pareja_id: parejaId });
  return m || fallar('Mes no encontrado', 404);
}

async function gastoDeLaPareja(db, id, parejaId) {
  const g = await db.collection('gastos').findOne({ _id: id });
  if (!g || !(await db.collection('meses').findOne({ _id: g.mes_id, pareja_id: parejaId }))) {
    fallar('Gasto no encontrado', 404);
  }
  return g;
}

async function cuotaDeLaPareja(db, id, parejaId) {
  const c = await db.collection('cuotas').findOne({ _id: id, pareja_id: parejaId });
  return c || fallar('Cuota no encontrada', 404);
}

const camposGasto = { projection: { pareja_id: 0 } };
const camposCuota = { projection: { pareja_id: 0 } };

// ---------- Acciones ----------

async function login(db, req, body) {
  const ip = ipCliente(req);
  const desde = new Date(Date.now() - LOGIN_BLOQUEO_MIN * 60 * 1000);
  const fallos = await db.collection('intentos_login').countDocuments({ ip, fecha: { $gt: desde } });
  if (fallos >= LOGIN_MAX_FALLOS) {
    fallar(`Demasiados intentos fallidos. Probá de nuevo en ${LOGIN_BLOQUEO_MIN} minutos.`, 429);
  }
  const usuario = texto(body.usuario, 40);
  const u = await db.collection('usuarios').findOne({ usuario });
  if (!u || !bcrypt.compareSync(String(body.password ?? ''), u.password_hash)) {
    await db.collection('intentos_login').insertOne({ ip, usuario, fecha: new Date() });
    fallar('Usuario o contraseña incorrectos', 401);
  }
  await db.collection('intentos_login').deleteMany({ ip });
  const token = crypto.randomBytes(32).toString('hex');
  await db.collection('sesiones').insertOne({ _id: token, usuario_id: u._id, creado: new Date(), ultimo_uso: new Date() });
  await sumarIngreso(db, u._id);
  return { token, usuario: datosUsuario(u) };
}

const acciones = {
  // Al abrir la app con una sesión guardada: cuenta como un ingreso más
  async sesion(db, yo, body) {
    if (body.ingreso) await sumarIngreso(db, yo._id);
    return { usuario: datosUsuario(yo) };
  },

  async logout(db, yo) {
    await db.collection('sesiones').deleteOne({ _id: yo.token });
    return { ok: true };
  },

  async acariciar(db, yo) {
    const ahora = new Date();
    const hoy = fechaLocal(ahora);
    // Actualización atómica: solo suma si pasó la espera y no se llegó al tope del día,
    // así dos caricias simultáneas no pueden saltear el límite
    const u = await db.collection('usuarios').findOneAndUpdate(
      {
        _id: yo._id,
        $and: [
          { $or: [{ caricia_ultima: null }, { caricia_ultima: { $lte: new Date(ahora - CARICIA_ESPERA_SEG * 1000) } }] },
          { $or: [{ caricias_dia: { $ne: hoy } }, { caricias_hoy: { $lt: CARICIAS_POR_DIA } }] },
        ],
      },
      [{
        $set: {
          caricias_hoy: { $cond: [{ $eq: ['$caricias_dia', hoy] }, { $add: ['$caricias_hoy', 1] }, 1] },
          caricias_dia: hoy,
          caricia_ultima: ahora,
          caricias: { $add: [{ $ifNull: ['$caricias', 0] }, 1] },
          puntos: { $add: [{ $ifNull: ['$puntos', 0] }, PUNTOS_CARICIA] },
        },
      }],
      { returnDocument: 'after' },
    );
    if (!u) {
      const estado = estadoCaricias(await db.collection('usuarios').findOne({ _id: yo._id }));
      const mensaje = estado.restantes === 0
        ? `Ya usaste las ${CARICIAS_POR_DIA} caricias de hoy. ¡Mañana hay más!`
        : `La mascota necesita un respiro: esperá ${estado.espera} segundos.`;
      fallar(mensaje, 429, { caricias: estado, ranking: await ranking(db, yo.pareja_id) });
    }
    await db.collection('puntos').insertOne({ usuario_id: yo._id, tipo: 'caricia', puntos: PUNTOS_CARICIA, fecha: ahora });
    return { ranking: await ranking(db, yo.pareja_id), caricias: estadoCaricias(u) };
  },

  // Datos completos de un mes de la pareja + planes de cuotas + ranking
  async mes(db, yo, body, query) {
    const anio = entero(query.anio, 'anio');
    const mes = entero(query.mes, 'mes');
    const pareja = yo.pareja_id;
    const idx = indiceMes(anio, mes);

    const fila = await db.collection('meses').findOne({ pareja_id: pareja, anio, mes });
    const gastos = fila
      ? await db.collection('gastos').find({ mes_id: fila._id }, camposGasto).sort({ orden: 1, _id: 1 }).toArray()
      : [];
    const cuotas = await db.collection('cuotas').find({ pareja_id: pareja }, camposCuota)
      .sort({ anio_inicio: 1, mes_inicio: 1, _id: 1 }).toArray();
    const idsCuotas = cuotas.map((c) => c._id);

    // Mes anterior más cercano con datos (para ofrecer copiarlo al crear uno nuevo)
    const anterior = await db.collection('meses').findOne(
      { pareja_id: pareja, idx: { $lt: idx } },
      { sort: { idx: -1 }, projection: { _id: 0, anio: 1, mes: 1 } },
    );

    // Cuotas ya pagadas en este mes
    const pagadas = await db.collection('cuotas_pagadas')
      .find({ cuota_id: { $in: idsCuotas }, anio, mes }, { projection: { _id: 0, cuota_id: 1, pagado_por: 1 } })
      .toArray();

    // Resumen de los meses siguientes ya creados, para la proyección
    const siguientesMeses = await db.collection('meses')
      .find({ pareja_id: pareja, idx: { $gte: idx + 1, $lte: idx + 12 } }).toArray();
    const sumas = await db.collection('gastos').aggregate([
      { $match: { mes_id: { $in: siguientesMeses.map((m) => m._id) } } },
      {
        $group: {
          _id: '$mes_id',
          fijos_variables: { $sum: { $cond: [{ $in: ['$categoria', ['fijo', 'variable']] }, '$maximo', 0] } },
          extras: { $sum: { $cond: [{ $eq: ['$categoria', 'extra'] }, '$maximo', 0] } },
          gastado: { $sum: '$gastado' },
        },
      },
    ]).toArray();
    const siguientes = siguientesMeses.map((m) => {
      const s = sumas.find((x) => x._id.equals(m._id)) || {};
      return {
        anio: m.anio, mes: m.mes, ingreso: m.ingreso, ahorro: m.ahorro,
        fijos_variables: s.fijos_variables || 0, extras: s.extras || 0, gastado: s.gastado || 0,
      };
    });
    const pagadasSiguientes = await db.collection('cuotas_pagadas')
      .find({ cuota_id: { $in: idsCuotas }, idx: { $gte: idx + 1, $lte: idx + 12 } },
        { projection: { _id: 0, cuota_id: 1, anio: 1, mes: 1 } })
      .toArray();

    return {
      mes: fila && { id: fila._id.toString(), anio: fila.anio, mes: fila.mes, ingreso: fila.ingreso, ahorro: fila.ahorro },
      gastos: gastos.map(salida),
      cuotas: cuotas.map(salida),
      cuotas_pagadas: pagadas.map(salida),
      anterior,
      siguientes,
      pagadas_siguientes: pagadasSiguientes.map(salida),
      ranking: await ranking(db, pareja),
      caricias: estadoCaricias(yo),
    };
  },

  // Crea un mes; opcionalmente copia ingreso, ahorro, fijos y variables del mes anterior
  async crear_mes(db, yo, body) {
    const anio = entero(body.anio, 'anio');
    const mes = entero(body.mes, 'mes');
    if (mes < 1 || mes > 12) fallar('Mes inválido');
    const pareja = yo.pareja_id;
    const idx = indiceMes(anio, mes);

    const previo = body.copiar
      ? await db.collection('meses').findOne({ pareja_id: pareja, idx: { $lt: idx } }, { sort: { idx: -1 } })
      : null;
    let nuevo;
    try {
      nuevo = await db.collection('meses').insertOne({
        pareja_id: pareja, anio, mes, idx, ingreso: previo?.ingreso ?? 0, ahorro: previo?.ahorro ?? 0,
      });
    } catch (e) {
      if (e.code === 11000) return { ok: true }; // ya existía (lo creó la otra persona)
      throw e;
    }
    if (previo) {
      const base = await db.collection('gastos')
        .find({ mes_id: previo._id, categoria: { $in: ['fijo', 'variable'] } }).toArray();
      if (base.length) {
        await db.collection('gastos').insertMany(base.map((g) => ({
          mes_id: nuevo.insertedId, categoria: g.categoria, detalle: g.detalle, maximo: g.maximo,
          gastado: 0, pagado: 0, nota: g.nota, orden: g.orden, creado_por: yo._id, pagado_por: null,
        })));
      }
    }
    return { ok: true };
  },

  async actualizar_mes(db, yo, body) {
    const id = oid(body.id);
    if (!['ingreso', 'ahorro'].includes(body.campo)) fallar('Campo inválido');
    await mesDeLaPareja(db, id, yo.pareja_id);
    await db.collection('meses').updateOne({ _id: id }, { $set: { [body.campo]: monto(body.valor) } });
    return { ok: true };
  },

  async agregar_gasto(db, yo, body) {
    const mesId = oid(body.mes_id, 'mes_id');
    if (!CATEGORIAS.includes(body.categoria)) fallar('Categoría inválida');
    await mesDeLaPareja(db, mesId, yo.pareja_id);
    const ultimo = await db.collection('gastos')
      .findOne({ mes_id: mesId, categoria: body.categoria }, { sort: { orden: -1 } });
    const doc = {
      mes_id: mesId, categoria: body.categoria, detalle: '', maximo: 0, gastado: 0, pagado: 0,
      nota: '', orden: (ultimo?.orden || 0) + 1, creado_por: yo._id, pagado_por: null,
    };
    const r = await db.collection('gastos').insertOne(doc);
    return salida({ _id: r.insertedId, ...doc });
  },

  async actualizar_gasto(db, yo, body) {
    const id = oid(body.id);
    let valor = body.valor ?? '';
    const cambios = {};
    switch (body.campo) {
      case 'detalle': cambios.detalle = texto(valor, 120); break;
      case 'nota': cambios.nota = texto(valor, 255); break;
      case 'maximo':
      case 'gastado': cambios[body.campo] = monto(valor); break;
      case 'pagado':
        // Se registra quién lo marcó como pagado
        valor = valor && valor !== '0' ? 1 : 0;
        cambios.pagado = valor;
        cambios.pagado_por = valor ? yo._id : null;
        break;
      case 'categoria':
        if (!CATEGORIAS.includes(valor)) fallar('Categoría inválida');
        cambios.categoria = valor;
        break;
      default: fallar('Campo inválido');
    }
    await gastoDeLaPareja(db, id, yo.pareja_id);
    await db.collection('gastos').updateOne({ _id: id }, { $set: cambios });
    return { ok: true };
  },

  async eliminar_gasto(db, yo, body) {
    const id = oid(body.id);
    await gastoDeLaPareja(db, id, yo.pareja_id);
    await db.collection('gastos').deleteOne({ _id: id });
    return { ok: true };
  },

  async agregar_cuota(db, yo, body) {
    const doc = {
      pareja_id: yo.pareja_id,
      detalle: texto(body.detalle, 120),
      monto_cuota: monto(body.monto_cuota),
      total_cuotas: Math.max(1, Math.min(99, entero(body.total_cuotas ?? 1, 'total_cuotas'))),
      anio_inicio: entero(body.anio_inicio, 'anio_inicio'),
      mes_inicio: entero(body.mes_inicio, 'mes_inicio'),
    };
    const r = await db.collection('cuotas').insertOne(doc);
    const { pareja_id, ...resto } = doc;
    return salida({ _id: r.insertedId, ...resto });
  },

  async actualizar_cuota(db, yo, body) {
    const id = oid(body.id);
    const valor = body.valor ?? '';
    const cambios = {};
    switch (body.campo) {
      case 'detalle': cambios.detalle = texto(valor, 120); break;
      case 'monto_cuota': cambios.monto_cuota = monto(valor); break;
      case 'total_cuotas': cambios.total_cuotas = Math.max(1, Math.min(99, entero(valor, 'total_cuotas'))); break;
      default: fallar('Campo inválido');
    }
    await cuotaDeLaPareja(db, id, yo.pareja_id);
    await db.collection('cuotas').updateOne({ _id: id }, { $set: cambios });
    return { ok: true };
  },

  // Marca o desmarca como pagada la cuota de un mes
  async marcar_cuota(db, yo, body) {
    const cuotaId = oid(body.cuota_id, 'cuota_id');
    const anio = entero(body.anio, 'anio');
    const mes = entero(body.mes, 'mes');
    await cuotaDeLaPareja(db, cuotaId, yo.pareja_id);
    if (body.pagado) {
      await db.collection('cuotas_pagadas').updateOne(
        { cuota_id: cuotaId, anio, mes },
        { $setOnInsert: { cuota_id: cuotaId, anio, mes, idx: indiceMes(anio, mes), pagado_por: yo._id } },
        { upsert: true },
      );
    } else {
      await db.collection('cuotas_pagadas').deleteOne({ cuota_id: cuotaId, anio, mes });
    }
    return { ok: true };
  },

  async eliminar_cuota(db, yo, body) {
    const id = oid(body.id);
    await cuotaDeLaPareja(db, id, yo.pareja_id);
    await db.collection('cuotas_pagadas').deleteMany({ cuota_id: id });
    await db.collection('cuotas').deleteOne({ _id: id });
    return { ok: true };
  },
};

// ---------- Entrada HTTP ----------

function leerBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

module.exports = async function handler(req, res) {
  // Permite usar la API desde otro origen (Live Server, la app de Android)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const responder = (status, data) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  };

  const query = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const accion = String(query.action || '');
  const body = leerBody(req);

  try {
    const db = await getDb();
    if (accion === 'login') return responder(200, await login(db, req, body));
    const yo = await usuarioActual(db, req);
    const fn = Object.prototype.hasOwnProperty.call(acciones, accion) ? acciones[accion] : null;
    if (!fn) fallar('Acción desconocida', 404);
    return responder(200, await fn(db, yo, body, query));
  } catch (e) {
    if (e instanceof Fallo) return responder(e.status, { error: e.message, ...e.extra });
    console.error(e);
    return responder(500, { error: process.env.MOSTRAR_ERRORES === '1' ? `Error del servidor: ${e.message}` : 'Error del servidor' });
  }
};
