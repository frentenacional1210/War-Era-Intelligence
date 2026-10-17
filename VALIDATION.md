# Validación de entrega

## Capturas solo en cambios relevantes del 17 de octubre de 2026

Aprobado por el usuario. En jugadores y artículos, un cambio que solo afecta a campos volátiles (`experience`, `lastConnectionAt`/`last_active_at`, `damagesCount`; `stats` de artículos) actualiza la ficha, pero no crea captura si ya hay una del mismo día UTC. Cualquier otro cambio, la primera observación y la primera del día sí la crean. Las batallas quedan fuera.

Implementación:
- `VOLATILE_SNAPSHOT_PATHS` y `volatileSnapshotGuard` en `worker/ingestion.ts`. La comparación usa `json_remove` dentro de `CASE WHEN json_valid(...)`, para no evaluar JSON heredado malformado.
- Sin migración y sin cambiar el hash ni el contrato de la API.

Pruebas: `tests/snapshot-sampling.test.ts` cubre jugadores (ruta masiva), artículos (ruta de pocas filas) y batallas. Total 166/166 en 29 archivos.

Simulación sobre la copia del 14 Oct (capturas del 12 al 14):
- Artículos: se habrían evitado 343 de 372 capturas repetidas, el 92 %.
- Jugadores: ninguna de 678, porque las revisitas eran de días distintos.

El ahorro inmediato es pequeño. Crecerá cuando los países completen el censo y se revisen cada 6 horas.


El Worker `b750d76c-649d-4a71-a4e7-5f2c766dcf24` muestra un aviso en todas las páginas cuando la información no está al día, a partir de `/api/status` y `ingestionFreshness` en `src/utils.ts`:
- **Pausa por cuota:** si al menos la mitad de las fuentes externas están en `quota-paused`, el aviso indica la última captura y cuánto falta para las 00:00 UTC.
- **Datos antiguos:** si no hay pausa, pero no hay capturas nuevas en más de una hora, se indica.
- Las fuentes derivadas (alertas y eventos) y las desactivadas no cuentan.

Verificación:
- Pruebas: 163/163 en 28 archivos, con `tests/freshness.test.ts`.
- En producción, con Edge, el aviso aparece en escritorio y móvil sin desbordamiento horizontal. El 17 Oct, 15:32 UTC, decía «Última captura hace 10 h. Se reanuda a las 00:00 UTC (dentro de 8 h 28 min)».
- Suite E2E completa contra producción: 53 correctas y 7 omitidas.

**Aplazado:** commits de 24 jugadores en lugar de 8. Requiere comprobar contra WarEra el `limit` admitido, el coste del lote frente al límite de 100 peticiones y el tamaño del cuerpo (hoy 32 KB, perfiles hasta 16 KB). Desde este equipo `api2.warera.io` no era accesible (TCP 443), como tampoco R2.


Medición en producción del 17 Oct, 14:50–15:20 UTC:
- 7.842 jugadores, 180 países iniciados, 138 con primera pasada completada, 42 pendientes y 417 recorridos completos.
- Desde las 04:3x UTC, 13 fuentes estaban en `quota-paused` con 79.765/80.000 escrituras reservadas y 71.480 medidas. La ingesta funcionó unas 4,5 horas del día UTC.
- Desglose por fuente (evidencia [write-budget-2026-10-17.json](artifacts/validation/write-budget-2026-10-17.json)):
  - jugadores del recolector: 15,8 escrituras por registro;
  - jugadores del cron: 17,5 escrituras por registro;
  - cinco ejecuciones fallidas retuvieron su reserva completa, unas 1.645 escrituras.

Cambios publicados en los Workers `09a25804-3ce1-41ad-958f-f130854adea9` y `8ff4d750-a987-425d-a28b-65defa8c1758`:
- **Reservas de ejecuciones fallidas.** Una ejecución que falla o queda obsoleta (409) antes de escribir entidades se liquida con las escrituras medidas por D1 más 8. Si las escrituras de datos ya empezaron, o falta metadato, conserva la reserva completa.
- **Cesión al recolector.** El cron no elige `players` ni `articles` mientras el recolector de GitHub haya confirmado una página de esa fuente en los últimos 30 minutos (`COLLECTOR_HANDOFF_SECONDS`). Las sincronizaciones administrativas explícitas no cambian. Si el recolector se detiene, el cron recupera la fuente.
- **Telemetría.** `/api/admin/status` añade `writeUsage`, el agregado diario por fuente y modo (recolector, cron, pausada o sin liquidar), visible en el panel de administración.

No se ha aumentado `INGESTION_DAILY_BUDGET` ni se han borrado reservas. El día 17 ya estaba agotado al desplegar, así que el efecto debe medirse a partir del 18 Oct comparando la hora de pausa y las escrituras por registro.

Pruebas: 160/160 en 27 archivos, TypeScript y build. Las nuevas pruebas de `tests/write-budget.test.ts` cubren:
- liquidación tras un 429 previo al guardado;
- reserva íntegra cuando falla una escritura de jugador;
- cesión con un commit reciente del recolector;
- recuperación tras 30 minutos de silencio;
- sincronización administrativa forzada.

**Pendiente:** migración `0017`, que elimina `idx_snapshots_entity_time`, duplicado del índice UNIQUE `(entity_type,entity_id,captured_at)`. En la copia del 14 Oct, `EXPLAIN QUERY PLAN` muestra que las consultas de análisis, ficha, último hash e históricos usan el índice UNIQUE u otros índices existentes, sin ordenación temporal. No se ha aplicado: la exportación D1 del 17 se creó, pero este equipo no pudo conectar con `*.r2.cloudflarestorage.com` (TCP 443) para descargarla, y la política exige una copia nueva verificada antes de cambiar el esquema.

## Recopilación de jugadores activos del 14 de octubre de 2026

El Worker `7f9ea9d4-d26c-4d16-846f-f4940c35ee56` publica la política `active-only`: Cron y commits del recolector guardan o actualizan perfiles solo cuando la marca pública de WarEra es exactamente `isActive: true`. Los candidatos falsos, nulos o sin marca se omiten antes de cualquier escritura de jugador, histórico o alerta; sus páginas avanzan igualmente. El recolector de GitHub consulta primero las fichas ligeras y pide fichas completas solo para activos. Los datos ya guardados se conservan y no representan el total actual de activos.

Pasaron 155 pruebas en 26 archivos, TypeScript y build. Se prueban selección estricta sin heurística de fecha, páginas sin activos, reactivación en un recorrido posterior, conservación de histórico al quedar inactivo, filtrado independiente del commit y solicitudes completas únicamente para activos. En producción, [active-only-live.json](artifacts/validation/active-only-live.json) confirma la política pública y los 4.770 perfiles previos conservados. Las cuatro pruebas de navegador de cobertura y búsqueda pasaron en escritorio/móvil. El plan remoto informó `quota-paused`; no se forzó una ingesta ni se reinició el presupuesto. La política se aplicará en los siguientes lotes programados cuando haya cuota, desde el próximo reinicio UTC (15 de octubre a las 00:00 UTC, 02:00 Madrid).

La sonda anónima y el contrato oficial confirman que `user.getUsersByCountry` no admite un filtro de actividad y que `user.getUserLite` devuelve la marca. Es necesario volver a comprobar los candidatos para descubrir reactivaciones; no se promete una detección instantánea. La estimación del usuario de aproximadamente 3.000 activos no se convierte en un límite artificial ni en un total verificado.

## Históricos completados el 14 de octubre de 2026

La vista [/historicos](https://warera-intelligence.warera-intelligence.workers.dev/historicos) está publicada en el Worker `2248bbf2-4a0a-48d3-8fc0-02963bab47a1`. Reúne los diez tipos de entidades históricas, comparación de hasta cuatro registros, medidas numéricas y categóricas, periodos/fechas/resoluciones, paginación y exportación de las páginas cargadas a CSV/JSON con su procedencia y metodología. El detalle del contrato y conservación está en [HISTORY.md](HISTORY.md).

`npm run check`, `npm run build`, `npm run docs:api` y la suite de 149 pruebas en 24 archivos pasaron. Las pruebas SQL cubren más de 200 capturas, empates de fecha, recuentos completos por intervalo, mezcla de detalle y archivo, resúmenes que cruzan una fecha final, retención por resolución, rollback, posesión del bloqueo, archivo por lotes y reanudación tras 1.001 filas no proyectables. El plan de consulta prueba el índice por fecha para evitar leer capturas recientes durante un mantenimiento vacío. La [verificación HTTP final](artifacts/validation/histories-live.json), del 14 a las 17:53:45 UTC, probó diez entidades reales en cinco periodos, páginas individuales, fechas personalizadas, parámetros inválidos, HEAD/GET, OPTIONS y CORS sin credenciales.

La [suite de navegador final](artifacts/validation/history-e2e.json), Edge de escritorio y móvil, terminó con 14 pruebas correctas, dos omisiones previstas y cero fallos. Ocho casos utilizan la API real de WINT y seis controlan respuestas públicas para verificar cambios categóricos, paginación y exportación. La prueba CORS utiliza un documento de consumidor servido por el test en otro origen y una consulta histórica real; no depende de disponibilidad de una web externa. Se revisaron las capturas [escritorio](artifacts/validation/history-chromium.png) y [móvil](artifacts/validation/history-mobile.png).

La migración incremental `0016_history_ordering.sql` se aplicó a la D1 existente tras [restaurar y verificar una copia privada](artifacts/validation/history-backup-before.json) en SQLite aislado: 17.853.081 bytes, SHA-256 `a343579bf906ff893df6410f8bc8adfefae651fb3f59e436517538d43f9f04ec`. La [simulación de migración](artifacts/validation/history-migration.json) conservó todos los contadores y pasó integridad y claves foráneas. La [comprobación remota posterior](artifacts/validation/history-persistence.json) confirmó las 11.406 capturas y 345 precios originales, sin restaurar producción. El [mantenimiento remoto final](artifacts/validation/history-maintenance-live.json) terminó correctamente con cero capturas vencidas y 18 lecturas medidas, frente a 7.905 en la consulta anterior; los presupuestos no se reiniciaron ni aumentaron.

La conservación se verifica mediante envejecimiento en SQLite de prueba. Todavía no hay capturas reales de 30 días ni dos años de datos: el archivo escalonado conserva observaciones futuras. Los resúmenes no pueden reconstruir todos los cambios intermedios ni un límite temporal dentro de un intervalo ya compactado; la respuesta lo indica. Las filas desconocidas o no proyectables permanecen en detalle para revisión.

## Endpoint JSON público del 13 de octubre de 2026

La petición «vale pues crea la url» se publicó en el Worker `d7190daf-a901-4005-8e56-474e25677dcf`: [entrada JSON pública](https://warera-intelligence.warera-intelligence.workers.dev/api/data), contrato `schemaVersion: "1.0"`. La respuesta reúne 14 categorías capturadas, fechas, cobertura, muestras y enlaces `nextUrl` para paginar; no requiere autenticación. Lee únicamente D1 y no realiza recolección ni inferencia. Las páginas contienen campos públicos seleccionados; los históricos e informes se descubren mediante enlaces. No hubo migraciones nuevas ni cambios de presupuesto.

`npm run check`, `npm run build` y `npm test` pasaron: 131 pruebas en 21 archivos. Los cinco casos nuevos verifican proyección pública, consultas SQL con cursor indexado, paginación durante inserciones, precios globales, errores/CORS y que HEAD no sustituya el cuerpo de GET en caché. La [verificación remota](artifacts/validation/public-data.json), a las 17:20:56 UTC, leyó el catálogo y una página de cada categoría y recorrió los 3.049 jugadores en 62 páginas sin duplicados. También comprobó HEAD seguido de GET, OPTIONS, POST rechazado, filtros inválidos y OpenAPI publicado. Fueron 82 solicitudes públicas, sin sesión ni escritura de datos. En Edge, un `fetch` desde `https://example.com` con `credentials: "omit"` devolvió HTTP 200 y respuesta `cors` con las 14 categorías. Esto verifica la lectura entre orígenes desde un navegador real.

El catálogo incluye hasta cinco fichas por categoría; un consumidor debe seguir las páginas para leer todos los registros. La coincidencia del recorrido de jugadores con el contador capturado se verificó durante la pausa de ingesta: las páginas vivas no constituyen una exportación atómica y sus cifras no representan todo WarEra. La actualización sigue los recopiladores existentes y sus presupuestos. Contrato y uso: [PUBLIC_DATA_API.md](PUBLIC_DATA_API.md).

## Medición remota del 13 de octubre de 2026

La comprobación final del Worker `7147d878` confirmó salud y portada HTTP 200, cierre de sesión 200 y sesión revocada 401. Los siete directorios conservaron sus muestras y contadores; [live.json](artifacts/validation/live.json) y [persistence.json](artifacts/validation/persistence.json). A las 16:43:46 UTC, [continuation.json](artifacts/validation/continuation.json) confirmó las siete rutas de diagnóstico y una ejecución de mantenimiento correcta: ninguna captura estaba aún vencida. Dos pruebas enfocadas de IA pasaron también sobre este backend; la suite completa y la prueba enfocada están distinguidas en [e2e-final.json](artifacts/validation/e2e-final.json).

A las 16:33 UTC, la consulta de estado registró 3.049 jugadores, 1.734 artículos, 180 países, 359 regiones, 629 partidos, 646 unidades militares, 71 batallas, 57 empresas, 60 elecciones, 20 gobiernos, 133 eventos y 133 alertas. El registro del libro de órdenes contó 24 productos con muestra. La cobertura de jugadores indicó 180 países iniciados, 58 con al menos una pasada completa y 122 en curso; ninguno sin iniciar. Se contabilizaron 61 pasadas completadas, 2.043 perfiles nuevos y 34 actualizados durante ese día. Son registros de WINT y no un censo mundial ni una estimación fiable de jugadores activos.

La cuota interna de ingestión de ese día tenía 79.793 de 80.000 escrituras reservadas (207 restantes), 71.617 escrituras y 75.225 lecturas medidas por las operaciones instrumentadas, y 538.725 lecturas reservadas. El tamaño informado de D1 era 13.475.840 bytes. Los contadores internos no incluyen toda operación de la cuenta ni equivalen a facturación de Cloudflare. La ingestión quedó pausada desde las 03:19 UTC por falta de margen para el siguiente lote; el reinicio UTC siguiente es el 14 de octubre a las 00:00 (02:00 Madrid). No se borró ni elevó el presupuesto para continuar.

Antes de corregir el caso de estrategia descrito a continuación, `npm run check`, `npm run build`, `npm run docs:api` y `npm test` pasaron localmente con 125/125 pruebas en 20 archivos. La versión `d6924703-0552-4739-a53c-3cedabb814ad` quedó publicada a las 16:35 UTC con doce herramientas IA, históricos de diez recursos y correcciones de cursores/afiliaciones. La prueba pública de «censo» de la versión anterior se documenta abajo. La [recepción final de navegador](artifacts/validation/e2e-final.json) sobre esa versión terminó a las 16:36:54 UTC: 43 pruebas correctas, siete omisiones previstas y cero fallos en Edge de escritorio/móvil. La pantalla de IA mostró 15 hechos, una cita y una interpretación desde caché, sin nueva inferencia; la interpretación apareció en inglés pese a la interfaz en español.

Una primera prueba de `strategy` con un ID de país presente literalmente en la pregunta devolvió HTTP 200, pero cero hechos y cero citas: el modelo había elegido la herramienta sin incluir su ID. Se corrigieron la instrucción del planificador, la recuperación acotada de IDs hexadecimales de 24 caracteres escritos por el usuario y la señal `no-facts` para herramientas sin hechos. `npm run check` y `npm test` pasaron con 126/126 pruebas en 20 archivos tras el cambio. La réplica real tras publicar `7147d878-9ab7-49b6-a8f0-d2d74c86df65` a las 16:40 UTC devolvió HTTP 200, un hecho y una cita de `strategy`, según [ai-strategy-live.json](artifacts/validation/ai-strategy-live.json). Ese país tenía fecha observada del 12 de octubre, anterior a otros recuentos publicados el 13. El modelo produjo una interpretación inválida, que la API rechazó con `interpretationAvailable=false`, `ai.available=false` y `reason=invalid-interpretation`. Queda validada la recuperación del dato y su cita en esa consulta; no la interpretación ni otras preguntas estratégicas.

La copia privada [backup.json](artifacts/validation/backup.json), exportada tras el despliegue y restaurada solo en SQLite aislado, pasó integridad y claves foráneas. El SQL tenía 11.160.399 bytes, hash SHA-256 `78b8ca692430a62011213cb46c9ca8bb4be91d003fd6407cce602ffbb7041017`, y conservó 3.049 jugadores, 1.734 artículos y 7.112 capturas de entidad. Producción no se restauró ni reinició. El cursor real de artículos medía 8.157 caracteres, por debajo del techo de 16.000; esta observación no prueba cursores futuros de mayor tamaño.

## Continuación verificada el 12 de octubre de 2026

La evidencia [continuation-2026-10-12.json](artifacts/validation/continuation-2026-10-12.json), tomada a las 19:29:43 UTC, devolvió HTTP 200 para cobertura, búsqueda, alertas, herramientas IA, diagnóstico administrativo, estrategia y política. En D1 había 1.006 jugadores, 482 artículos, 180 países, 269 regiones, 329 partidos, 336 unidades militares y 42 batallas; empresas, elecciones, gobiernos, eventos y alertas tenían cero registros. Un módulo con ruta funcional y tabla vacía no constituye cobertura real de su dominio. La copia [backup-2026-10-12.json](artifacts/validation/backup-2026-10-12.json) fue restaurada en SQLite aislado, sin restaurar producción, y verificó 2.813 capturas de entidad. Estas cifras describen un instante, no el total del juego ni un censo terminado.

El estado remoto informó `reserved=79.869` de `dailyBudget=80.000`, con solo 131 escrituras internas disponibles: insuficientes para otro turno normal de ingestión. Esto equivale a pausa operativa por presupuesto, aunque no a 80.000 escrituras físicas exactas. Los campos remotos `measuredWrites=0` y `measuredReads=0` de esa respuesta no proporcionan una medición acumulada fiable de D1; la cuota oficial de cuenta no se deduce del contador WINT. El mantenimiento separado devolvió HTTP 200, sin filas antiguas elegibles, `rowsWritten=4` y `rowsRead=17` medidos en esa invocación. No se alteró el presupuesto ni se forzó recopilación para validar.

La primera prueba administrativa de Workers AI devolvió 503 en la versión observada. Entonces no hubo confirmación de inferencia gratuita utilizable y las dos puertas de activación pública permanecieron cerradas. El código local posterior reserva 120 neuronas antes de la llamada, admite tres validaciones por hora y devuelve un diagnóstico acotado del proveedor. La migración 0014 de índices estratégicos está aplicada; otras modificaciones locales posteriores requieren contraste con la versión desplegada antes de declararlas publicadas.

Una segunda validación administrativa real a las 19:29:44 UTC devolvió HTTP 200, `available=true` y `responseKind=object` para `@cf/meta/llama-3.2-3b-instruct`, según [continuation-2026-10-12.json](artifacts/validation/continuation-2026-10-12.json). La respuesta estructurada del proveedor explica el fallo de normalización inicial. Esta prueba confirma el binding y el modelo en esa llamada acotada; todavía no prueba el flujo público completo de plan, hechos, interpretación, caché y cuotas. La activación de las dos puertas y la consulta pública se verifican por separado.

La revisión posterior `f21329f6` publicó también la migración 0015, el backend y la interfaz de primeras órdenes públicas. La fuente está habilitada, pero tenía cero filas guardadas por pausa de presupuesto: solo se ha demostrado el estado `pending`, no una captura real ni su coste. El censo de países comunicado en esa revisión era 137 iniciados de 180, con tres pasadas completas, 134 en curso y 43 sin empezar. Las tablas de empresas, elecciones y gobiernos seguían vacías a la espera de nuevas capturas después del reinicio UTC.

La versión `7f9ae0e9-5b69-43be-8bf4-b43be6ca1a1a` quedó publicada a las 19:39 UTC con `/prensa`, `/api/press`, históricos de diez recursos y la corrección de IA. La evidencia [ai-live.json](artifacts/validation/ai-live.json) registra una consulta pública real de «censo» a las 19:39:45 UTC: HTTP 200, 15 hechos procedentes del registro capturado, una cita, interpretación presente y `ai.available=true` con el modelo gratuito fijo. Esta observación valida ese flujo, no la exactitud de cualquier interpretación ni las herramientas cuyas tablas seguían vacías. La prensa trabaja sobre hasta cien metadatos recientes; sus temas y relaciones se infieren solo del título. La recepción de navegador final de la versión posterior se registra en la sección del 13 de octubre.

La integración local más reciente pasó `npm run check`, `npm run build`, `npm run docs:api` y `npm test` con 124 pruebas en 20 archivos, incluidas pruebas SQLite de censo, búsqueda, índices, prensa, límites de ingesta y herramientas IA de mercado/estrategia/prensa. El despliegue y la consulta pública citados arriba contrastan rutas concretas; las herramientas IA añadidas después están verificadas localmente y aún no publicadas en esa versión. Ninguna de estas pruebas sustituye la prueba de navegador final ni una auditoría de cada fuente.

Las secciones históricas siguientes corresponden a versiones y recuentos anteriores. Sus cifras de pruebas, CPU y registros no reemplazan esta evidencia ni garantizan el estado de la versión actual.

## Ampliación del 12 de octubre de 2026

La Fase 1 sigue teniendo cobertura parcial. Al empezar esta revisión había 82 jugadores y 47 artículos; la reserva fija había consumido 59.920 de las 60.000 escrituras presupuestadas, aunque no representaba escrituras reales. Se conserva ese consumo previo y las capturas exitosas nuevas ajustan sus reservas usando `meta.rows_written` de D1. El nuevo presupuesto de recopilación es 80.000, compartido por ambos recolectores, con margen para otras operaciones de la cuenta; no equivale a una auditoría de facturación.

Se eliminó el tope artificial del archivo de artículos, se separó la búsqueda de novedades de su cursor histórico y el censo rota entre países con puntos de continuación persistentes. El Cron obtiene cuatro perfiles por lote; el recolector compacto obtiene ocho y descarta campos no utilizados antes de llegar al Worker. Ambos usan las mismas exclusiones de artículos privados, bloqueos, controles de cursores y transacciones. GitHub Actions ejecuta el recolector cada quince minutos; su programación puede sufrir retrasos.

Verificación local: 58 pruebas correctas, TypeScript correcto y compilación de producción correcta. En la web publicada pasaron ocho pruebas de navegador, con dos casos omitidos deliberadamente por corresponder al otro tamaño de pantalla. Se verificaron portada y salud HTTP 200, logout 200 y sesión revocada 401. Los siete directorios conservaron sus muestras reales y contadores tras el despliegue. La Fase 2 incorpora comparación de dos a cuatro jugadores, partidos o unidades, e históricos de hasta noventa capturas reales; una sola observación no produce cambios inventados.

El Worker `bdd6baf2-3f52-42dc-ab19-1949356386f9` procesó ocho jugadores por petición compacta con 4–6 ms de CPU en las cinco peticiones observadas durante el ensayo local. Al incluir la ejecución desde GitHub, las 91 peticiones compactas observadas registraron 3–26 ms, catorce superaron 10 ms y ninguna presentó excepciones. Un Cron de artículos registró 13 ms. Siguen existiendo picos y esta evidencia no garantiza que toda ejecución respete el límite nominal de 10 ms. Evidencias sin credenciales: `artifacts/validation/collector-final-cpu.json`, `throughput-before.json`, `throughput-after.json`, `live.json` y `persistence.json`.

La [ejecución remota del recolector](https://github.com/frentenacional1210/War-Era-Intelligence/actions/runs/38220279969) terminó correctamente con ochenta pasos: 311 perfiles y 205 artículos públicos procesados. Procesados no significa necesariamente nuevos: las capturas repetidas son idempotentes. Tras las comprobaciones se observaron 541 jugadores y 288 artículos almacenados, con páginas de 65 de los 180 países recorridas y un primer recorrido nacional terminado. Estos indicadores no equivalen a un censo global completo. La [validación del código](https://github.com/frentenacional1210/War-Era-Intelligence/actions/runs/38220251877) también terminó correctamente. Resumen verificable: `artifacts/validation/github-collector.json`. Las capturas de escritorio y móvil de portada y análisis se revisaron visualmente en `artifacts/`.

## Validación inicial del 11 de octubre de 2026

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

En la validación inicial del 11 de octubre, la entrega correspondía a la Fase 1 y adelantaba el esquema de históricos, un importador acotado y simuladores de supuestos editables. El censo crecía por lotes; las cifras no describían todos los jugadores ni todos los países del juego. La hora de captura y la procedencia acompañaban los datos. La reconciliación de batallas y el libro de primeras órdenes se añadieron después; los precios seguían siendo globales y no medían volumen ni liquidez nacional.

Los artículos marcados privados, eliminados o no publicados se excluyen. Solo se conservan metadatos públicos, sin reproducir cuerpos de texto. En esa entrega inicial todavía no había fuente de empresas ni IA activada; las secciones de continuación anteriores registran su estado posterior. Elecciones completas, datos privados, mapa territorial histórico y Discord siguen sin cobertura verificada completa.

No se ha activado facturación ni se ha contratado un proveedor de pago. Workers AI se activó después de esa validación inicial y tiene un techo interno inferior al gratuito publicado. La autorización OAuth permite desplegar pero rechaza la consulta de suscripciones; no se afirma haber auditado la facturación preexistente de la cuenta. El presupuesto de recopilación es una reserva estimada, no el contador de filas facturadas de Cloudflare.
