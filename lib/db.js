// Conexión a MongoDB reutilizable entre invocaciones (en Vercel cada función
// puede reutilizar el proceso, así que el cliente se guarda en una variable global).
const { MongoClient } = require('mongodb');

let promesa = global._gastosMongo;

async function conectar() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Falta la variable de entorno MONGODB_URI');
  // Tiempos cortos: si Atlas no responde (por ejemplo, Network Access no permite la IP),
  // es mejor devolver un error claro que agotar el tiempo máximo de la función en Vercel
  const cliente = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  await cliente.connect();
  const db = cliente.db(process.env.MONGODB_DB || 'gastos_mes');
  await asegurarIndices(db);
  return db;
}

async function asegurarIndices(db) {
  await Promise.all([
    db.collection('usuarios').createIndex({ usuario: 1 }, { unique: true }),
    db.collection('usuarios').createIndex({ pareja_id: 1 }),
    db.collection('meses').createIndex({ pareja_id: 1, anio: 1, mes: 1 }, { unique: true }),
    db.collection('meses').createIndex({ pareja_id: 1, idx: 1 }),
    db.collection('gastos').createIndex({ mes_id: 1, orden: 1 }),
    db.collection('cuotas').createIndex({ pareja_id: 1 }),
    db.collection('cuotas_pagadas').createIndex({ cuota_id: 1, anio: 1, mes: 1 }, { unique: true }),
    db.collection('puntos').createIndex({ usuario_id: 1, tipo: 1, fecha: 1 }),
    db.collection('sesiones').createIndex({ usuario_id: 1 }),
    // Los intentos de ingreso fallidos se borran solos al día
    db.collection('intentos_login').createIndex({ fecha: 1 }, { expireAfterSeconds: 24 * 60 * 60 }),
    db.collection('intentos_login').createIndex({ ip: 1, fecha: 1 }),
  ]);
}

function getDb() {
  if (!promesa) {
    promesa = conectar().catch((e) => { promesa = null; global._gastosMongo = null; throw e; });
    global._gastosMongo = promesa;
  }
  return promesa;
}

module.exports = { getDb };
