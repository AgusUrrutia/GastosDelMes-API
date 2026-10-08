// Copia la web (index.html, app.js, styles.css de la carpeta principal) a public/,
// que es lo que Vercel publica junto con la API.
const fs = require('fs');
const path = require('path');

const origen = path.join(__dirname, '..', '..');
const destino = path.join(__dirname, '..', 'public');

fs.mkdirSync(destino, { recursive: true });
for (const archivo of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(origen, archivo), path.join(destino, archivo));
  console.log(`copiado ${archivo}`);
}
