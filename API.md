# API WINT · v0.1

La API pública lee únicamente D1. No inicia llamadas a WarEra por visita. El documento [OpenAPI](public/openapi.json) se sirve en `/openapi.json`. Todas las fechas de captura usan ISO 8601 UTC; la interfaz las presenta en la zona del navegador.

| Ruta GET | Respuesta |
| --- | --- |
| `/api/health` | `ok`, servicio y versión; comprueba la conexión D1 |
| `/api/status` | fuentes, errores, última captura, totales almacenados y estado IA |
| `/api/dashboard/summary` | estado, artículos recientes, batallas activas y precios observados |
| `/api/countries`, `/api/regions`, `/api/players`, `/api/parties`, `/api/military-units`, `/api/battles`, `/api/companies`, `/api/articles`, `/api/events`, `/api/alerts` | `{items,total,page,limit,source}` |
| `/api/<recurso>/:id` | `{item,history,source}`; 404 si todavía no está recopilado |
| `/api/markets/prices` | precios globales más recientes, buscables y paginados |
| `/api/markets/history?item=ID` | hasta 288 observaciones persistidas del producto |

Las colecciones aceptan `q` (40 bytes UTF-8 máximo), `country` (ID original), `page` (1–10000), `limit` (1–50), `sort` y `order=asc|desc`. Ordenaciones comunes: `name` y `updated_at`; jugadores además `level` y `experience`; artículos además `published_at`. Los precios aceptan `name`, `price` o `captured_at`. Los textos de búsqueda se escapan y los valores SQL se parametrizan; los nombres de tabla y columna proceden de listas cerradas.

Cada registro conserva `id`, `name`, `country_id`, `source_url`, `updated_at`, `first_seen` y `data` con una selección de campos públicos. Los campos ausentes son `null`, no estadísticas estimadas. `history` es un historial de variaciones, no una serie de capturas a intervalos regulares. El censo inicial es parcial: `total` mide datos de WINT, nunca el universo completo del juego.

`updated_at` conserva la fecha de actualización de WarEra cuando existe; de lo contrario usa la captura. La última ejecución satisfactoria de la fuente aparece en `source.last_success`; las capturas históricas tienen su propio `captured_at`. La sincronización de una página no significa que se haya completado todo el censo.

La caché pública dura 60 segundos en navegador y 90 en el punto de presencia de Cloudflare. El limitador permite 120 peticiones por minuto e IP en cada ubicación de Cloudflare, y no constituye una cuota global exacta. Los errores devuelven `{error}` y códigos 400, 401, 403, 404, 405, 413, 429 o 503. La caída de una fuente conserva sus filas previas y marca la antigüedad; el agotamiento de D1 puede impedir temporalmente respuestas no cacheadas.

## Administración

Las rutas administrativas no usan caché. Todas las mutaciones necesitan `X-WINT-CSRF: 1`; si existe `Origin`, debe coincidir con el origen del Worker. No se permite CORS externo. La contraseña se comprueba contra un hash PBKDF2 del servidor y la sesión de ocho horas se almacena en D1 y se firma con HMAC. Cookie HttpOnly, SameSite Strict y Secure bajo HTTPS. El cierre revoca la sesión.

| Método y ruta | Cuerpo o efecto |
| --- | --- |
| `POST /api/admin/login` | `{password}`; cinco intentos por IP cada 15 min |
| `POST /api/admin/logout` | revoca sesión |
| `GET /api/admin/status` | estado, cuota estimada y últimas 50 ejecuciones, solo autenticado |
| `POST /api/admin/sync` | `{source?}`; una unidad reanudable de trabajo, diez solicitudes cada diez min |
| `PATCH /api/admin/sources/:id` | `{enabled:boolean,interval_seconds:number}` (120–86400) |
| `POST /api/admin/import/preview` | multipart `file` y `resource`, o JSON `{resource,records}`; CSV/JSON/ZIP ≤1 MB |
| `POST /api/admin/import` o `/api/admin/import/commit` | `{resource,records}`; hasta diez registros validados por petición |

Importación disponible para `players`, `parties`, `military-units`. Exige ID y nombre; informa duplicados conflictivos. Las filas existentes se omiten para conservar su procedencia. Los registros importados se atribuyen a `import:administrator`, nunca a una consulta verificada de WarEra. Las importaciones grandes se envían en lotes; pueden quedar parcialmente aplicadas si un lote posterior falla, y son reanudables al omitir los IDs ya insertados.

No existen rutas de inferencia ni SQL libre. La IA, el motor de alertas, los resultados electorales y los mapas históricos pertenecen a fases posteriores descritas en [ROADMAP.md](ROADMAP.md).

## Comparadores e históricos

`GET /api/analysis/compare?resource=players&ids=id1,id2` compara entre dos y cuatro IDs distintos de `players`, `parties` o `military-units`. Devuelve métricas públicas de la última captura y su procedencia; no interpreta datos ausentes como cero. `GET /api/analysis/history?resource=players&id=id1` devuelve hasta noventa capturas reales en orden cronológico. Los cambios requieren dos valores observados y un valor inicial cero no produce un porcentaje.

## Recopilador automático

`POST /api/collector/plan` y `POST /api/collector/commit` son rutas privadas de máquina protegidas con `Authorization: Bearer COLLECTOR_SECRET`, con caché desactivada. No aceptan sesiones de visitantes ni la contraseña administrativa. El plan describe una página de jugadores o artículos; el commit valida sus campos públicos, tamaño, IDs y cursor, y aplica los mismos bloqueos y presupuesto de D1 que el Cron. Una página obsoleta produce HTTP 409 y debe volver a prepararse. No son rutas de escritura pública.
