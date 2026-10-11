# Despliegue en Cloudflare Free

Despliegue existente comprobado por HTTPS: **https://warera-intelligence.warera-intelligence.workers.dev**. Worker: `warera-intelligence`; D1: `wint-db`. El UUID configurado corresponde a la base remota ya migrada. No recree la base ni rote los secretos al actualizar el código. No se ha activado facturación ni un servicio de pago durante el despliegue. La sesión OAuth no permite consultar suscripciones de la cuenta; el plan efectivo y las cuotas facturadas se revisan en el panel de Cloudflare.

En esta instalación el acceso administrativo está guardado en `artifacts/private/ADMIN_ACCESS.txt`, excluido de Git y con permisos locales restringidos. Para actualizar basta `npm run deploy`; los datos permanecen en D1 y los secretos en Cloudflare. Las instrucciones siguientes permiten reproducir la instalación en otra cuenta.

1. Instale dependencias y compruebe la compilación:

   ```powershell
   npm install
   npm run check
   npm test
   npm run build
   ```

2. Autentique Wrangler en la cuenta elegida:

   ```powershell
   npx wrangler whoami
   npx wrangler login
   npx wrangler whoami
   ```

   `login` solo hace falta si `whoami` indica que no hay sesión. Compruebe en el panel que la cuenta está en Workers Free.

3. Cree la base D1 y asigne su UUID a `wrangler.jsonc`. El script solo crea una base si `database_id` sigue siendo el marcador de ceros y la cuenta está autenticada:

   ```powershell
   node scripts/setup-cloudflare.mjs
   npm run db:migrate:remote
   ```

   Si ya existe `wint-db` en la cuenta, obtenga su UUID con `npx wrangler d1 list`, escríbalo en `database_id` y ejecute la migración; no cree otra base. Las migraciones son idempotentes en el registro de Wrangler, pero afectan datos remotos: revise la cuenta y la base antes de aplicarlas.

4. Genere secretos. La contraseña queda solo en la variable de su terminal durante la generación; el script muestra el hash y un secreto de sesión aleatorio. Introduzca los valores generados en los comandos sin guardarlos en Git:

   ```powershell
   $env:WINT_ADMIN_PASSWORD='una-contraseña-larga-y-única'
   node scripts/admin-password.mjs
   Remove-Item Env:WINT_ADMIN_PASSWORD
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put SESSION_SECRET
   ```

   Wrangler solicita cada valor por entrada segura. Guarde la contraseña administrativa en un gestor de contraseñas. `WARERA_API_KEY` solo se configura como secreto adicional si la API y la autorización lo requieren. La IA permanece desactivada.

5. Despliegue y pruebe:

   ```powershell
   npm run deploy
   curl https://SU-SUBDOMINIO.workers.dev/api/health
   curl https://SU-SUBDOMINIO.workers.dev/api/status
   ```

   Anote la URL real que devuelve Wrangler. Compruebe portada, búsqueda de jugadores, artículos, estado de fuentes y acceso administrativo. Ejecute una sincronización mediante el panel o `WINT_URL=https://… npm run sync` con `WINT_ADMIN_PASSWORD` en el entorno. Verifique en `/api/admin/status` que queda un `ingestion_run`, que D1 conserva registros entre despliegues y que el Cron produce nuevas ejecuciones. Los datos públicos dependen de que las fuentes verificadas respondan; no se deben sustituir por datos ficticios. Revise los logs con `npx wrangler tail` y el uso real en el panel de Cloudflare.

El Cron `* * * * *` se despliega con `wrangler.jsonc`. Los intervalos internos de fuentes reducen trabajo repetido. Los límites gratuitos oficiales se explican en [ARCHITECTURE.md](ARCHITECTURE.md); el agotamiento de la cuota de D1 corta consultas hasta el reinicio UTC.

## Verificar esta instalación

```powershell
$env:WINT_URL='https://warera-intelligence.warera-intelligence.workers.dev'
$env:WINT_BROWSER_CHANNEL='msedge'
npm run test:e2e
node scripts/verify-live.mjs
node scripts/watch-cron.mjs
```

`verify-live.mjs` utiliza internamente el archivo privado, comprueba la sesión y su revocación y escribe evidencias sin credenciales en `artifacts/validation/live.json`. `--sync` recopila un lote por fuente y consume ocho ejecuciones de sincronización. `watch-cron.mjs` observa cuatro minutos de eventos programados y conserva solo resultados, CPU y número de excepciones; descarta cabeceras y metadatos de visitantes. La propagación inicial del Cron puede tardar hasta quince minutos. El panel administrativo muestra las últimas ejecuciones y un presupuesto estimado, independiente de la medición de Cloudflare.

`node scripts/verify-hydration.mjs` fuerza dos lotes de países y dos de regiones para comprobar descubrimiento y continuación. Usa la credencial local sin imprimirla y consume cuatro solicitudes de sincronización. Para observar también su CPU, ejecute el observador con `WINT_TAIL_SYNC=true`; solo registra resúmenes de `/api/admin/sync`, nunca cabeceras, cuerpos ni cookies. La continuación normal del Cron no necesita esa opción.

El remoto GitHub de esta entrega es `https://github.com/frentenacional1210/War-Era-Intelligence.git`. La publicación conserva su commit inicial y licencia AGPL-3.0. El despliegue de Cloudflare utiliza Wrangler y no depende de GitHub para seguir funcionando.
