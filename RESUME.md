# Punto de continuidad

**17–18 Oct, noche:** completada la lista de `TODO.md`. Publicados el recolector de 24 jugadores, la migración 0017 (copia previa verificada), la IA en español por nombres, títulos en español, la ficha de país conectada, el seguimiento, la carga diferida de gráficos, la auditoría de accesibilidad, `/hoy`, la actividad semanal, la alerta operativa y `npm run backup`. Pendiente principal: verificar el recolector y el presupuesto tras la reanudación del 18 Oct a las 00:00 UTC (ver `TODO.md`).

**17 Oct, tarde:** capturas solo en cambios relevantes para jugadores y artículos (aprobado por el usuario), publicado en el Worker `ff7ac0cf-ce72-4f93-b0b3-c99cd4e4cd3f`. Detalle en `HISTORY.md` y `VALIDATION.md`. Desde el 18 Oct, comprobar en producción que las capturas de jugadores y artículos crecen menos que sus actualizaciones (`/api/admin/status` → `writeUsage`, y recuento de `entity_snapshots` por día).

**17 Oct, después:**
- Aviso global de frescura publicado (Worker `b750d76c-649d-4a71-a4e7-5f2c766dcf24`).
- Hoja de mejoras priorizada:
  1. commits de recolector mayores, aplazados por falta de acceso a WarEra desde esta red;
  2. capturas solo en cambios relevantes, que requiere decisión del usuario;
  3. IA con resolución por nombre y respuesta en español;
  4. fichas de país conectadas;
  5. panel de seguimiento;
  6. carga diferida de gráficos;
  7. revisión de accesibilidad;
  8. resumen diario;
  9. títulos de eventos en español (hoy «Election finished in public record»).

**Actualización del 17 Oct 2026.**
- Medición: 7.842 jugadores y 138/42 países completados/pendientes. El presupuesto interno de 80.000 escrituras se agota hacia las 04:30 UTC y la ingesta queda pausada el resto del día.
- Workers `8ff4d750-a987-425d-a28b-65defa8c1758` publicados con tres cambios: liquidación de reservas en ejecuciones fallidas antes de escribir datos, cesión de `players`/`articles` al recolector durante 30 minutos y `writeUsage` por fuente en `/api/admin/status`. Detalle en `VALIDATION.md`.
- Medir el efecto desde el 18 Oct.
- Pendiente: migración 0017 (eliminar el índice redundante `idx_snapshots_entity_time`). Está verificada en SQLite pero sin aplicar, porque falta descargar una copia nueva: R2 era inaccesible desde este equipo. El archivo no está en el repositorio. Su contenido es `DROP INDEX IF EXISTS idx_snapshots_entity_time;`.

Estado verificado el 14 de octubre de 2026. Tras completar los históricos, el usuario pidió recopilar solo jugadores marcados activos. La política automática `isActive === true` está implementada, publicada y comprobada. `/historicos` y `/api/data` permanecen operativos.

- Proyecto y rama: `warera-intelligence`, `main`, repositorio https://github.com/frentenacional1210/War-Era-Intelligence ; licencia AGPL-3.0 conservada. Consultar Git y Actions al retomar para comprobar la última revisión.
- Producción: https://warera-intelligence.warera-intelligence.workers.dev ; Worker `7f9ea9d4-d26c-4d16-846f-f4940c35ee56`. Migraciones remotas `0001`–`0016` aplicadas. La D1 original no se ha recreado ni reinicializado.
- Política de jugadores: solo perfiles `isActive === true` se guardan/actualizan automáticamente. Falso, nulo y ausente se omiten; los candidatos se revisitan por país para detectar reactivaciones. WarEra no ofrece filtro de actividad en el listado. GitHub pide perfil ligero para todos los candidatos y completo solo para activos. El Worker vuelve a filtrar antes de persistir. Los registros e históricos previos no se borran. `/api/coverage` publica `playerCollectionPolicy`; los commits devuelven contadores comprobados/omitidos. Evidencia `artifacts/validation/active-only-live.json`.
- Históricos: `/historicos` permite comparar cuatro entidades de diez tipos, elegir medida, periodo, fechas UTC y resolución, cargar páginas y exportar CSV/JSON. `/api/history` mantiene el contrato previo y añade cursor, metodología versión `2`, retención, fuente actual y límites explícitos de resúmenes. El mantenimiento conserva detalle hasta archivar, ordena empates por ID, reanuda candidatos no proyectables mediante cursor y usa el índice por fecha. Guía `HISTORY.md`; evidencias `histories-live.json`, `history-e2e.json`, `history-maintenance-live.json`, `history-migration.json`, `history-persistence.json`.
- URL JSON: https://warera-intelligence.warera-intelligence.workers.dev/api/data . Contrato `schemaVersion: "1.0"`, catálogo de 14 recursos con muestras de cinco registros y páginas de hasta 50 siguiendo `datasets[resource].pagination.nextUrl`. Público sin sesión ni clave, con CORS `*`, consulta D1 sin llamadas a WarEra o inferencia. Recorrió los 3.049 jugadores en 62 páginas sin duplicados; lectura desde `https://example.com` correcta en Edge. Guía `PUBLIC_DATA_API.md`, OpenAPI publicado y evidencia `artifacts/validation/public-data.json`. Los datos se actualizan por los recopiladores existentes, sujetos a sus cuotas.
- Medición del 14 Oct, 17:55 UTC: 4.770 jugadores, 3.164 artículos, 180 países, 386 regiones, 739 partidos, 726 unidades, 99 batallas, 84 empresas, 90 elecciones, 30 gobiernos y 250 eventos/alertas. Libro de órdenes: 24 productos capturados. Son registros de WINT, no totales mundiales.
- Censo: los 180 países iniciados, 98 con primera pasada completada, 82 pendientes de completarla, 150 recorridos completos acumulados. Sin denominador mundial fiable de jugadores, activos o ETA.
- Presupuesto interno del 14: 79.812/80.000 escrituras reservadas; 188 disponibles, insuficientes para el siguiente lote. Pausa automática; siguiente reinicio a las 00:00 UTC del 15 Oct, 02:00 de Madrid. No borrar reservas ni eludir las cuotas. Mediciones parciales de ingesta: 71.006 escrituras y 79.411 lecturas; no equivalen al consumo total de Cloudflare. El mantenimiento histórico final sin candidatos vencidos midió 18 lecturas y cuatro escrituras; no archivar fechas ficticias en producción.
- Cron cada minuto y recolector GitHub cada quince minutos configurados. El collector actualizado obtiene perfiles completos y solo transmite campos públicos permitidos. Los tokens de continuación se compactan en huellas compatibles con cursores antiguos. Campos país/partido/unidad omitidos conservan el valor observado; `null` explícito lo limpia.
- Publicados: cobertura, filtros y búsqueda, históricos de diez recursos con ventanas hasta dos años, relaciones, política, militar, industria, mundo esquemático, informe por país, hemeroteca de títulos, alertas y libro de primeras cinco órdenes por lado. Retención larga conserva observaciones futuras; no reconstruye datos anteriores a la primera captura.
- Workers AI activo con presupuesto y herramientas de solo lectura. Censo público verificado con 15 hechos, una cita e interpretación. Estrategia pública verificada con un hecho y una cita; su interpretación fue rechazada por controles y la respuesta conservó los hechos. El proveedor puede devolver inglés pese a la instrucción en español. No presentar una interpretación como hecho ni declarar todas las herramientas verificadas individualmente.
- Industria → IA transmite escenarios explícitos por estado del navegador, sin inferencias automáticas. La recuperación automática de identificadores solo acepta tokens de 24 caracteres hexadecimales ya escritos en la pregunta.
- Pruebas actuales: 155/155 unitarias e integración en 26 archivos; TypeScript y build correctos. Cobertura/búsqueda tras política activa: cuatro pruebas de escritorio/móvil correctas. Suite histórica de la entrega anterior: 14 correctas y dos omisiones; evidencia `artifacts/validation/history-e2e.json`. La suite global anterior de interfaz en `d6924703` dio 43 correctas y siete omisiones; no confundir ambas ejecuciones.
- Copia privada previa a históricos: `artifacts/private/backups/pre-history-2026-10-14.sql`, 17.853.081 bytes, SHA-256 `a343579bf906ff893df6410f8bc8adfefae651fb3f59e436517538d43f9f04ec`. Restaurada únicamente en SQLite en memoria: integridad y claves foráneas correctas. La migración simulada conservó contadores; producción retuvo las 11.406 capturas y 345 precios. Metadatos en `artifacts/validation/history-backup-before.json`. Copias y pruebas anteriores siguen conservadas.

Prioridades restantes: completar las 82 primeras pasadas pendientes, observar consumo y archivo real cuando haya capturas vencidas, mejorar consulta por nombres e idioma del proveedor, ampliar fuentes militares verificadas y modelos hipotéticos. Los históricos solicitados tienen código, interfaz, pruebas y despliegue: la retención de 24 meses conserva datos futuros, no crea observaciones previas. Revisar `IMPLEMENTATION_GAPS.md`, `ROADMAP.md` y `VALIDATION.md`; no declarar todas las fases completas. Chat, cuerpos de artículos y datos privados siguen condicionados a fuente permitida o autorización.

Credenciales y copias SQL están en `artifacts/private/`, excluido de Git. No imprimirlas ni incorporarlas al repositorio. No restaurar producción durante verificaciones rutinarias.
