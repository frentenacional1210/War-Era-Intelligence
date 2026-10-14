# Despliegue en Cloudflare Free

## Históricos publicados el 14 de octubre de 2026

Worker `2248bbf2-4a0a-48d3-8fc0-02963bab47a1`, migraciones aplicadas hasta `0016_history_ordering.sql`. La migración añade orden de capturas y cursor de mantenimiento a las tablas existentes, conservando sus datos. La copia privada previa se restauró únicamente en SQLite aislado antes de aplicar el cambio. Consulte [HISTORY.md](HISTORY.md) y [VALIDATION.md](VALIDATION.md) para la interfaz `/historicos`, la API paginada y las comprobaciones de conservación.

## Estado medido el 13 de octubre de 2026

La instalación existente tiene migraciones remotas aplicadas hasta `0015_orderbooks.sql`. La versión `7147d878-9ab7-49b6-a8f0-d2d74c86df65`, publicada el 13 a las 16:40 UTC, incluye `/prensa`, `/api/press`, históricos de diez recursos, doce herramientas IA fijas y la recuperación acotada del ID para `strategy`, además de la protección de cursores/afiliaciones del recolector. A las 16:33 UTC se observaron 24 productos con muestra, 3.049 jugadores y 1.734 artículos. No se reinicializó D1. La copia SQL privada nueva (`release-2026-10-13.sql`) se restauró únicamente en SQLite aislado: integridad y claves foráneas correctas, 11.160.399 bytes y 7.112 capturas; evidencia sin datos sensibles en [backup.json](artifacts/validation/backup.json). No se ha restaurado en producción. Consulte [VALIDATION.md](VALIDATION.md) para distinguir hechos/citas de interpretaciones del modelo.

El presupuesto interno diario de ingestión de 80.000 escrituras tenía 79.793 reservadas a las 16:33 UTC del día 13, sin margen para otro turno. No aumente, borre ni reinicie el contador para forzar capturas. La ventana se reinicia automáticamente a las 00:00 UTC del 14 de octubre (02:00 en Madrid). El mantenimiento histórico reserva por separado hasta 15.000 escrituras y un millón de lecturas al día, con techo conjunto de 95.000 escrituras con ingestión; el Cron lo ejecuta en una invocación distinta cada diez minutos. La cuota oficial de D1 es de cuenta e incluye índices y operaciones externas a estos contadores.

La instalación activó `AI_ENABLED=true` y `ai_config.enabled=1` después de validar el modelo gratuito. La ruta administrativa de validación reserva 120 neuronas antes de cada prueba, admite hasta tres por hora y devuelve 503 si el proveedor rechaza el modelo. La consulta pública «censo» real devolvió 200 con hechos, cita, interpretación y `ai.available=true` a las 19:39:45 UTC; evidencia en `artifacts/validation/ai-live.json`. Se mantiene un techo interno de 5.000 neuronas/día y 120 reservadas por solicitud; no habilite facturación de pago para ampliar el techo. Los secretos de sesión, administrador y recolector permanecen fuera de Git.

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

   Wrangler solicita cada valor por entrada segura. Guarde la contraseña administrativa en un gestor de contraseñas. `WARERA_API_KEY` solo se configura como secreto adicional si la API y la autorización lo requieren. En una instalación nueva, la IA empieza desactivada hasta validar el proveedor, configurar el binding y activar las dos puertas.

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

## Recopilación complementaria

`Collect public WarEra data` ejecuta `scripts/collect.ts` cada quince minutos en un runner Ubuntu estándar. El repositorio público permite su uso gratuito; no cambie a runners grandes. El Cron de Cloudflare sigue funcionando si GitHub retrasa una tarea. Las ejecuciones comparten cursores y cuota de D1 y solo envían metadatos públicos seleccionados, sin cuerpos de artículos ni respuestas completas de perfiles.

El secreto independiente `COLLECTOR_SECRET` está configurado en Cloudflare y como `WINT_COLLECTOR_SECRET` en GitHub. El archivo local `artifacts/private/COLLECTOR_SECRET.txt` está excluido de Git y restringido a la cuenta de entrega. No se usa la contraseña administrativa ni se publica ese archivo. Para reproducir la configuración en esta misma cuenta: autentique Wrangler y Git como propietario del repositorio, instale `python -m pip install PyNaCl` y ejecute `python scripts/setup-collector.py`. El script exige un repositorio público administrado por ese propietario, cifra el secreto para GitHub y no imprime su valor.

Una prueba local del mismo recopilador se ejecuta con `WINT_URL`, `COLLECTOR_SECRET` y `MAX_STEPS` (1–80) como variables de entorno, mediante `npm run collect`. Para ejecución remota use **Actions → Collect public WarEra data → Run workflow**. El workflow agrupa todas sus ejecuciones para evitar solapamientos y tiene un límite de catorce minutos. Los logs contienen estados y contadores, no identificadores, páginas, perfiles ni credenciales. Con `WINT_TAIL_SYNC=true`, `watch-cron.mjs` también conserva resúmenes de CPU de los commits del recopilador.
