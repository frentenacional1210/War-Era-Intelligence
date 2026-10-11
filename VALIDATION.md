# Validación de entrega

Fecha: 11 de octubre de 2026. URL comprobada: **https://warera-intelligence.warera-intelligence.workers.dev**.

## Evidencias reproducibles

- `npm run check` y `npm run build`: TypeScript y compilación de producción correctos.
- `npm test`: 35 pruebas correctas. Incluyen SQL real sobre las migraciones, filtros, protección administrativa, revocación de sesión, límites, reintentos, cursores, presupuesto, idempotencia, compatibilidad de hashes, rollback de lotes, carreras de cursores, descubrimiento/hidratación, privacidad de artículos/importaciones y cálculos reproducibles.
- `WINT_URL` con la URL pública y `WINT_BROWSER_CHANNEL=msedge`: seis pruebas de navegador correctas en escritorio y móvil; portada, directorios, mercados, ficha de un jugador real, procedencia, administración anónima restringida y simulador editable.
- `scripts/verify-live.mjs --sync`: ocho capturas reales guardadas en D1 y servidas por la API. Portada y salud HTTP 200; sesión administrativa válida, logout 200 y sesión revocada 401. La captura inicial se conserva en `artifacts/validation/initial-sync.json`; el estado y las comprobaciones más recientes se guardan sin contraseña ni cookies en `artifacts/validation/live.json`.
- Cron remoto `* * * * *`: ejecuciones autónomas observadas, sin petición administrativa. La primera añadió diez países y la siguiente cinco jugadores. Resúmenes sin metadatos de visitantes: `artifacts/validation/cron.json`.
- Capturas de la web pública revisadas visualmente en `artifacts/dashboard-desktop.png` y `artifacts/dashboard-mobile.png`.

Los navegadores leen la misma D1 central; ninguna visita inicia recopilación en WarEra. El despliegue fija el UUID de D1 y mantiene sus secretos en Cloudflare. `scripts/verify-persistence.mjs --before`, un nuevo despliegue y `scripts/verify-persistence.mjs` comprueban los contadores y la conservación de una entidad real en cada uno de siete directorios.

La comprobación de persistencia ha pasado en los siete directorios; evidencia: `artifacts/validation/persistence.json`. Los lotes se redujeron a tres registros o un jugador y las escrituras se agruparon en transacciones. En el Worker `3a0271ae-1e7b-4550-a986-fca62df6aa8b`, las ejecuciones de partidos y unidades militares consumieron 6 y 8 ms de CPU con resultado correcto; las primeras de países y jugadores registraron picos de 26 y 20 ms, también correctos. Los límites nominales gratuitos son 10 ms: la tolerancia a picos de Cloudflare no garantiza cargas sostenidas superiores al límite. Conserve seguimiento del uso real; evidencias sin credenciales en `artifacts/validation/cron-optimized.json`.

La versión `4aa139d7-b907-48f2-bc28-8d4e5723a5c4` guarda la lista de IDs de países/regiones una vez por recorrido y consulta después sus fichas individuales. Cuatro sincronizaciones administrativas reales (descubrimiento y continuación de ambas fuentes) dieron HTTP 200 y tres registros por lote. CPU observada: países 26→11 ms, regiones 20→9 ms; estas mediciones HTTP incluyen autenticación y límite administrativo. Los primeros listados grandes siguen teniendo un coste puntual. Evidencias: `artifacts/validation/hydration.json` y `artifacts/validation/hydration-cpu.json`. Para comprobar la continuación desde el Cron se adelantó exclusivamente la próxima fecha de esas dos fuentes; no se alteró ningún registro del juego.

Las continuaciones posteriores ejecutadas por el Cron real procesaron tres países con 10 ms y tres regiones con 9 ms, ambas con resultado `ok` y ninguna excepción. Países está registrado en `hydration-cpu.json` (evento `kind:cron`) y regiones en `hydration-cron.json`. Los picos de descubrimiento ocurren una vez por recorrido y deben seguir vigilándose; no se ha aumentado el límite ni activado un plan de pago.

GitHub conserva la licencia AGPL-3.0 inicial. La primera ejecución de [GitHub Actions](https://github.com/frentenacional1210/War-Era-Intelligence/actions/runs/38179191303) terminó correctamente: instalación con el lockfile, TypeScript, pruebas y compilación en Linux con Node 24.

## Alcance y límites

La entrega corresponde a la Fase 1 y adelanta el esquema de históricos, un importador acotado y simuladores de supuestos editables. El censo crece por lotes; las cifras no describen todos los jugadores ni todos los países del juego. La hora de captura y la procedencia acompañan los datos. Los estados de batalla representan lo observado en la última captura; todavía no existe una reconciliación completa de conflictos que desaparecen del listado activo. Los precios son globales y la serie registra cambios, no volúmenes ni un libro de órdenes nacional.

Los artículos marcados privados, eliminados o no publicados se excluyen. Solo se conservan metadatos públicos, sin reproducir cuerpos de texto. Empresas no tiene fuente confirmada. IA, elecciones completas, alertas estadísticas, grafos, mapa territorial histórico y Discord siguen pendientes y se identifican en la interfaz y ROADMAP.md.

No se ha activado facturación ni se ha contratado un proveedor de pago. Workers AI permanece desactivado. La autorización OAuth permite desplegar pero rechaza la consulta de suscripciones; no se afirma haber auditado la facturación preexistente de la cuenta. El presupuesto de recopilación es una reserva estimada, no el contador de filas facturadas de Cloudflare.
