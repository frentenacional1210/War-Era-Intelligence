# API WINT · v0.1

La API pública lee únicamente D1. No inicia llamadas a WarEra por visita. El documento [OpenAPI](public/openapi.json) se sirve en `/openapi.json`. Todas las fechas de captura usan ISO 8601 UTC; la interfaz las presenta en la zona del navegador.

| Ruta GET | Respuesta |
| --- | --- |
| `/api/health` | `ok`, servicio y versión; comprueba la conexión D1 |
| `/api/data` | catálogo JSON central de los 14 recursos públicos capturados, con enlaces para recorrer sus páginas |
| `/api/data?resource=players&limit=50` | página JSON de un recurso con cursor `after` y `nextUrl` para continuar |
| `/api/status` | fuentes, errores, última captura, totales almacenados y estado IA |
| `/api/dashboard/summary` | estado, artículos recientes, batallas activas y precios observados |
| `/api/countries`, `/api/regions`, `/api/players`, `/api/parties`, `/api/military-units`, `/api/battles`, `/api/companies`, `/api/elections`, `/api/governments`, `/api/articles`, `/api/events`, `/api/alerts` | `{items,total,page,limit,source}` |
| `/api/<recurso>/:id` | `{item,history,source}`; 404 si todavía no está recopilado |
| `/api/markets/prices` | precios globales más recientes, buscables y paginados |
| `/api/markets/history?item=ID` | hasta 288 observaciones persistidas del producto |
| `/api/markets/orderbook?item=ID` | última muestra guardada de hasta cinco órdenes públicas por lado; `pending` para producto conocido aún sin captura |
| `/api/coverage?page=1&limit=30` | avance parcial del censo por país y metodología |
| `/api/search?q=texto&limit=30` | búsqueda de nombres e IDs públicos en siete recursos |
| `/api/press?country=ID&language=es&limit=50` | muestra reciente de hasta 100 metadatos públicos, tendencias y títulos relacionados por palabras |
| `/api/history?resource=players&id=ID&period=30d` | puntos observados, agregados, huecos y línea base; máximo 200 puntos |
| `/api/relations?resource=players&id=ID` | relaciones verificadas de una entidad |
| `/api/politics?country=ID` | gobierno y elecciones disponibles del país |
| `/api/strategy?country=ID` | informe descriptivo por país: cobertura, política, industria, noticias y lagunas |
| `/api/military?unit=ID` | unidad, miembros observados y evidencia militar |
| `/api/alerts/feed?limit=20` | alertas por reglas deterministas sobre cambios observados |
| `/api/ai/tools` | herramientas de consulta y estado de activación de IA |

Las colecciones aceptan `q` (40 bytes UTF-8 máximo), `country` (ID original), `page` (1–10000), `limit` (1–50), `sort` y `order=asc|desc`. Ordenaciones comunes: `name` y `updated_at`; jugadores además `level` y `experience`; artículos además `published_at`. Los precios aceptan `name`, `price` o `captured_at`. Los textos de búsqueda se escapan y los valores SQL se parametrizan; los nombres de tabla y columna proceden de listas cerradas.

`GET /api/data` es la entrada pública para clientes como Grok: responde sin autenticación ni inferencia, con CORS `*` y versión de esquema `1.0`. El sobre común contiene `schemaVersion`, `generatedAt`, `scope`, `mode`, `resource`, `datasets`, `coverage`, `links` y `limitations`. Sin `resource` devuelve `mode: "catalog"`, los catorce datasets y hasta cinco filas reales por dataset (`limit=1–10` en catálogo), más un resumen de cobertura observada. Con `resource` devuelve `mode: "dataset"`, `coverage: null` y solo `datasets[resource]`, que contiene `url`, `totalCaptured`, `lastSuccessfulCollectionAt`, `status`, `items` y `pagination`. La página tiene 1–50 filas (50 por defecto), ordenadas por ID; el cliente debe seguir `datasets[resource].pagination.nextUrl` mientras `hasMore=true`. `after` es un cursor ID opaco, no un número de página. `HEAD` y `OPTIONS` están disponibles; las respuestas de error incluyen CORS. `totalCaptured` es el contador almacenado de la fuente o `null` si no hay uno: no es una estimación del mundo del juego ni un recuento recalculado por solicitud. Los registros muestran solo campos públicos seleccionados. Véase [la guía de recorrido y límites](PUBLIC_DATA_API.md) y el esquema OpenAPI de `/api/data`.

Cada registro conserva `id`, `name`, `country_id`, `source_url`, `updated_at`, `first_seen` y `data` con una selección de campos públicos. Los campos ausentes son `null`, no estadísticas estimadas. `history` es un historial de variaciones, no una serie de capturas a intervalos regulares. El censo inicial es parcial: `total` mide datos de WINT, nunca el universo completo del juego.

El libro de órdenes usa exclusivamente la última muestra almacenada en D1 y solo acepta un ID del catálogo observado. `buyOrders` y `sellOrders` contienen como máximo cinco ofertas de cada lado, con precio, cantidad y fecha declarados por la fuente; no son transacciones, liquidez total ni disponibilidad futura. La ruta devuelve 404 para un producto desconocido y `status:pending` con listas vacías para uno conocido sin captura. La ruta y la migración 0015 están publicadas; 24 productos tenían muestra en la medición remota del 13 de octubre a las 16:33 UTC.

`GET /api/press` acepta solo `country` (ID simple), `language` (código de 2–16 letras/guiones), `from` y `to` (días UTC inclusive) y `limit` (1–100, por defecto 50); rechaza filtros desconocidos o repetidos. Primero consulta como máximo 100 fichas recientes para país/fechas; aplica idioma dentro de esa muestra y limita `items` para la respuesta. Devuelve `sampled`, `matched`, `isSample=true`, cobertura `latest-100-captured-metadata`, tendencias diarias y por palabras del título. Cada ficha aporta título, IDs, fechas, URL de origen, temas inferidos y hasta seis títulos relacionados que comparten un tema no genérico. Ningún cuerpo o comentario se lee; temas y relaciones no verifican hechos ni representan la hemeroteca completa.

`updated_at` conserva la fecha de actualización de WarEra cuando existe; de lo contrario usa la captura. La última ejecución satisfactoria de la fuente aparece en `source.last_success`; las capturas históricas tienen su propio `captured_at`. La sincronización de una página no significa que se haya completado todo el censo.

La caché pública dura 60 segundos en navegador y 90 en el punto de presencia de Cloudflare. El limitador permite 120 peticiones por minuto e IP en cada ubicación de Cloudflare, y no constituye una cuota global exacta. Los errores devuelven `{error}` y códigos 400, 401, 403, 404, 405, 413, 429 o 503. La caída de una fuente conserva sus filas previas y marca la antigüedad; el agotamiento de D1 puede impedir temporalmente respuestas no cacheadas.

## Administración

Las rutas administrativas no usan caché. Todas las mutaciones necesitan `X-WINT-CSRF: 1`; si existe `Origin`, debe coincidir con el origen del Worker. No se permite CORS externo. La contraseña se comprueba contra un hash PBKDF2 del servidor y la sesión de ocho horas se almacena en D1 y se firma con HMAC. Cookie HttpOnly, SameSite Strict y Secure bajo HTTPS. El cierre revoca la sesión.

| Método y ruta | Cuerpo o efecto |
| --- | --- |
| `POST /api/admin/login` | `{password}`; cinco intentos por IP cada 15 min |
| `POST /api/admin/logout` | revoca sesión |
| `GET /api/admin/status` | estado, cuota estimada y últimas 50 ejecuciones, solo autenticado |
| `GET /api/admin/coverage`, `/api/admin/diagnostics` | cobertura y diagnóstico de migraciones privados |
| `POST /api/admin/maintenance` | ejecuta un lote acotado de archivo histórico |
| `POST /api/admin/ai/validate` | prueba el binding/modelo de IA con salida máxima de 32 tokens, reserva previa de 120 neuronas y límite de tres intentos por hora; un fallo del proveedor devuelve 503 sin activar la IA |
| `POST /api/admin/sync` | `{source?}`; una unidad reanudable de trabajo, diez solicitudes cada diez min |
| `PATCH /api/admin/sources/:id` | `{enabled:boolean,interval_seconds:number}` (120–86400) |
| `POST /api/admin/import/preview` | multipart `file` y `resource`, o JSON `{resource,records}`; CSV/JSON/ZIP ≤1 MB |
| `POST /api/admin/import` o `/api/admin/import/commit` | `{resource,records}`; hasta diez registros validados por petición |

Importación disponible para `players`, `parties`, `military-units`. Exige ID y nombre; informa duplicados conflictivos. Las filas existentes se omiten para conservar su procedencia. Los registros importados se atribuyen a `import:administrator`, nunca a una consulta verificada de WarEra. Las importaciones grandes se envían en lotes; pueden quedar parcialmente aplicadas si un lote posterior falla, y son reanudables al omitir los IDs ya insertados.

`GET /api/coverage` nunca presenta el censo observado como la población total del juego. `summary.countries_pending` significa países sin una pasada completa; `countries_not_started` y `countries_in_progress` distinguen los dos estados. `GET /api/history` acepta recursos `players`, `parties`, `military-units`, `countries`, `regions`, `battles`, `markets`, `companies`, `elections` y `governments`; periodos `7d`, `30d`, `90d`, `1y` y `2y`. Conserva observaciones recientes y agregados diarios (90 días), semanales (un año) y mensuales (al menos dos años), más la primera línea base disponible. Los huecos, el truncamiento y el archivo pendiente son explícitos; no reconstruye capturas borradas antes de activar el archivo. Empresas, elecciones y gobiernos ya tenían 57, 60 y 20 filas respectivamente el 13 de octubre, pero ello no crea series anteriores ni acredita cobertura completa. `GET /api/alerts/feed` acepta `country`, `theme`, `severity`, `since`, `until` y `limit` (1–50). Las alertas indican cuándo se observó el cambio, no la hora real del suceso; las coincidencias de artículos usan solo títulos públicos.

`GET /api/strategy?country=ID` devuelve `country`, `coverage`, `politics`, `military`, `industry`, hasta doce `events` y doce `press`, `freshness`, `missing` y `methodology`. El país debe existir en D1 o se devuelve 404. La interfaz compara dos solicitudes independientes de esta ruta; sus recuentos son registros capturados, no estimaciones de poder, causalidad, liquidez o actividad total. Los eventos proceden de reglas de cambios observados y la prensa de metadatos públicos.

`POST /api/ai/query` acepta `{ "question": "..." }` (1–1000 bytes UTF-8) y, para cálculos económicos, un objeto opcional `scenarios` con `base` y `upgrade` explícitos. Exige `X-WINT-CSRF: 1` y un origen coincidente cuando se envía `Origin`; limita por actor a cinco consultas por hora y treinta por día. Devuelve hechos de herramientas D1 de solo lectura, citas, fecha observada, datos ausentes, supuestos e `interpretation` separada. El catálogo incluye histórico de mercados, resumen estratégico de hasta dos países y muestra de prensa de hasta un país; para IDs concretos, estos deben aparecer literalmente en la pregunta. Prensa usa solo títulos/metadatos y un máximo de veinte fichas en IA. No ejecuta SQL propuesto por el modelo ni lee el cuerpo de artículos. Si el proveedor falla o su interpretación no supera la validación, devuelve hechos deterministas con `ai.available=false`; si se agota la cuota de inferencia, responde 429. La IA está activada en esta instalación tras validar el binding Workers AI, `AI_ENABLED=true` y `ai_config.enabled=1`: una consulta pública real de «censo» devolvió hechos, una cita y una interpretación con `ai.available=true` el 12-10-2026. Una consulta real de `strategy` el 13-10-2026 devolvió un hecho y una cita, pero rechazó una interpretación inválida (`ai.available=false`); prensa e histórico de mercados están probados localmente, aún no individualmente en vivo. En otra instalación la puerta doble está desactivada por defecto y responde 503 hasta su activación. Se reservan 120 neuronas por solicitud, con techo interno de 5000 al día, máximo efectivo de 41 solicitudes reservables y hasta dos inferencias acotadas. No se utilizan servicios de pago ni claves de modelos externos.

## Comparadores e históricos

La vista `/historicos` reúne los diez recursos históricos y permite comparar hasta cuatro entidades, escoger fechas/resolución y exportar las páginas cargadas. `GET /api/history` añade `grain`, `from`, `to`, `limit` y `cursor`; responde en orden cronológico con `nextUrl`, metodología versión `2`, procedencia y retención. Los filtros desconocidos o repetidos se rechazan. CORS permite lectura pública entre orígenes; HEAD no altera la caché de GET. Las capturas antiguas pendientes de resumen siguen visibles. El contrato, los límites de los intervalos archivados y las garantías del mantenimiento están en [HISTORY.md](HISTORY.md).

`GET /api/analysis/compare?resource=players&ids=id1,id2` compara entre dos y cuatro IDs distintos de `players`, `parties` o `military-units`. Devuelve métricas públicas de la última captura y su procedencia; no interpreta datos ausentes como cero. `GET /api/analysis/history?resource=players&id=id1` devuelve hasta noventa capturas reales en orden cronológico. Los cambios requieren dos valores observados y un valor inicial cero no produce un porcentaje.

## Recopilador automático

`POST /api/collector/plan`, `POST /api/collector/commit` y `POST /api/collector/maintenance` son rutas privadas de máquina protegidas con `Authorization: Bearer COLLECTOR_SECRET`, con caché desactivada. No aceptan sesiones de visitantes ni la contraseña administrativa. El plan describe una página de jugadores o artículos; el commit valida sus campos públicos, tamaño, IDs y cursor, y aplica los mismos bloqueos y presupuesto de D1 que el Cron. Una página obsoleta produce HTTP 409 y debe volver a prepararse. Maintenance archiva a lo sumo veinte capturas y veinte precios por ejecución bajo un presupuesto propio de D1. No son rutas de escritura pública.
