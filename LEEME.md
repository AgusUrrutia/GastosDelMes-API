# API de Gastos del mes (Node + MongoDB, para Vercel)

Reemplaza a la API en PHP (`../api/`) con las mismas acciones y respuestas.
Este proyecto publica en Vercel la API (`/api`) y también la web (`public/`).

## Probar en la PC

1. Copiar `.env.example` como `.env`. Para pruebas sirve el Mongo local
   (`MONGODB_URI=mongodb://127.0.0.1:27017`).
2. `npm install`
3. `npm run dev`. La web y la API quedan en <http://localhost:3000>.
   Con "Go Live" (puerto 5500), la web usa sola esta API en el puerto 3000.

## Pasar los datos de MySQL (XAMPP) a MongoDB

Con XAMPP/MySQL iniciado y `MONGODB_URI` apuntando a donde se quieren los datos:

```
npm run migrar                      # falla si Mongo ya tiene datos
npm run migrar -- --reemplazar      # borra lo que haya en Mongo y copia de nuevo
```

Copia usuarios (con sus contraseñas), meses, gastos, cuotas, pagos e historial de puntos.
Las sesiones no se copian: hay que volver a ingresar.

## Publicar en Vercel

1. **MongoDB Atlas**:
   - En *Database Access*, crear un usuario de base de datos.
   - En *Network Access*, permitir `0.0.0.0/0`, porque Vercel no tiene una IP fija.
   - Copiar la cadena de conexión en *Connect → Drivers*.
2. Cargar los datos en Atlas: poner esa cadena en `MONGODB_URI` del `.env` y ejecutar `npm run migrar`.
3. `npm run copiar-web`, para que `public/` tenga la última versión de la web.
4. Publicar desde esta carpeta (`api-node`):
   - `npx vercel login`
   - `npx vercel`: crea el proyecto. Cuando pregunte, el directorio es `./`.
   - `npx vercel env add MONGODB_URI`: pegar la cadena de Atlas para Production (y Preview si se quiere).
   - `npx vercel --prod`
5. Con la dirección final (por ejemplo `https://<proyecto>.vercel.app`):
   - Poner `API_REMOTA = 'https://<proyecto>.vercel.app/api'` en `../app.js`.
   - Regenerar el APK (`npm run build` en `../android-app`).

Variables de entorno: `MONGODB_URI` (obligatoria), `MONGODB_DB` (por defecto `gastos_mes`),
`MOSTRAR_ERRORES=1` (solo en desarrollo).
