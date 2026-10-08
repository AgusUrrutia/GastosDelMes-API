// Servidor local para probar sin Vercel: sirve la web (public/) y la API (/api)
// igual que en Vercel. Uso: npm run dev  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/index');

const PUERTO = Number(process.env.PORT) || 3000;
const PUBLICO = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api' || url.pathname === '/api/') {
    let datos = '';
    req.on('data', (c) => { datos += c; });
    req.on('end', () => {
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = datos ? JSON.parse(datos) : {}; } catch { req.body = {}; }
      handler(req, res);
    });
    return;
  }

  const archivo = path.join(PUBLICO, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!archivo.startsWith(PUBLICO) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    res.statusCode = 404;
    return res.end('No encontrado');
  }
  res.setHeader('Content-Type', TIPOS[path.extname(archivo)] || 'application/octet-stream');
  fs.createReadStream(archivo).pipe(res);
}).listen(PUERTO, '0.0.0.0', () => {
  console.log(`Gastos del mes: http://localhost:${PUERTO}`);
});
