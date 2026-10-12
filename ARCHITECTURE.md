# Arquitectura

```text
API pública WarEra ──► Worker: recopilación incremental (Cron/admin)
                             │
                             ▼
                      D1: datos y capturas
                             │
                             ▼
Navegadores ──► Worker: API pública de lectura ──► React/Vite
                   │
                   └──► API administrativa: sesión, estado, importación y sincronización
```

Un solo Worker sirve los assets de `dist/` y `/api/*`. `worker/ingestion.ts` mantiene cursores, fuentes y registros de ejecución; las migraciones SQL definen la base D1. Las entidades conservan IDs externos estables, campos consultables y `data_json` con los atributos públicos restantes. Las capturas históricas registran cambios. Si una fuente falla, se registra el error y los datos existentes quedan consultables con su hora de captura. El Cron está declarado cada minuto, pero cada fuente decide su siguiente ejecución mediante intervalo y cursor. El frontend consulta la base central mediante API y refresca las vistas periódicamente.

La API pública pagina las listas (máximo 50 registros por petición), valida filtros y usa consultas parametrizadas. La administración usa una contraseña PBKDF2-SHA256 con 100 000 iteraciones, sesiones firmadas guardadas en D1, cookie HttpOnly/SameSite y cabecera de protección CSRF. Los secretos `ADMIN_PASSWORD_HASH` y `SESSION_SECRET` existen solo en el entorno del Worker. Las importaciones validan el recurso y el contenido; los INSERT no sustituyen filas existentes.

Cada minuto se atiende una fuente vencida, protegida por bloqueos global y por fuente. Cinco de cada diez turnos priorizan jugadores, dos artículos y tres las demás fuentes; un turno libre se comparte. Cada país conserva su propio cursor y se recoge una página antes de rotar al siguiente, evitando que un país grande monopolice el censo. Los artículos mantienen un cursor de archivo sin el antiguo límite de veinte páginas y revisan periódicamente la portada sin perder ese cursor.

Los lotes son de cuatro jugadores desde el Cron directo, ocho desde el recolector compacto, diez candidatos en listados paginados y tres fichas de países/regiones. Los perfiles se obtienen mediante una petición tRPC conjunta verificada. Los lotes de más de tres entidades se escriben con dos sentencias SQL basadas en `json_each`, conservando transacciones, hashes y capturas idempotentes. Contadores mantenidos mediante triggers evitan recorrer toda la tabla en cada captura o listado sin filtros. Las búsquedas filtradas siguen necesitando lecturas proporcionales a los resultados y deben vigilarse al crecer.

El presupuesto diario es de 80 000 escrituras de recopilación. Se reserva de forma conservadora antes de consultar; al finalizar se suma `meta.rows_written` de todas las respuestas D1 y se devuelve la reserva no usada, manteniendo ocho escrituras adicionales de margen para liquidar el contador. Si faltan metadatos o una ejecución falla, no se devuelve esa reserva. Las reservas de versiones antiguas se conservan hasta el reinicio UTC. El contador no incluye otros proyectos ni todas las operaciones administrativas de la cuenta, por lo que sigue siendo un límite operativo y no una auditoría de facturación.

La recopilación complementaria en GitHub Actions obtiene las respuestas grandes fuera del Worker y envía solamente campos públicos seleccionados. Usa un runner Ubuntu estándar del repositorio público, sin artefactos de perfiles, almacenamiento externo ni servicios de pago. El Worker autentica un secreto exclusivo de recopilación, valida de nuevo los registros y conserva los mismos bloqueos, cursores y presupuesto que el Cron. Las tareas se programan cada quince minutos; GitHub puede retrasarlas. El Cron permanece como respaldo y atiende las otras fuentes. Los navegadores únicamente consultan D1 y no realizan recopilación.

Las credenciales de recopilación se almacenan como secretos en Cloudflare y GitHub; no se envía la contraseña administrativa a Actions. Una carrera con un cursor avanzado rechaza la página preparada, sin saltar registros. Se rechazan cursores que se repiten dentro de las últimas 64 páginas y continuaciones vacías de artículos. Los checkpoints de país y el cierre de una ejecución comprueban la propiedad del bloqueo.

## Economía

`shared/economics.ts` ofrece aritmética de escenarios con entradas editables. Ingresos diarios = unidades × precio; materias = unidades × coste de material; impuestos = ingresos × tasa introducida; beneficio = ingresos − materias − impuestos − salarios − costes fijos − coste de oportunidad. ROI diario = beneficio / inversión y amortización = inversión / beneficio cuando ambos valores son positivos. La comparación de ampliación resta beneficios y capital entre dos escenarios. La cadena productiva compara vender materia prima con transformarla según rendimiento, costes y precios dados por el usuario. Ninguna de estas ecuaciones se afirma como regla oficial de WarEra.

## Límites gratuitos verificados (11-10-2026)

| Servicio | Límite gratuito relevante |
| --- | --- |
| Workers | 100 000 solicitudes/día, 10 ms de CPU por solicitud HTTP, 50 subsolicitudes por invocación; Cron en la misma cuenta. |
| D1 | 500 MB por base, 5 GB por cuenta, 5 millones de filas leídas/día, 100 000 escritas/día y 50 consultas por invocación Free. |
| Workers AI | 10 000 neurons/día; en esta fase está desactivado. |

Fuentes: [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/), [límites de D1](https://developers.cloudflare.com/d1/platform/limits/), [precios/cuotas de D1](https://developers.cloudflare.com/d1/platform/pricing/) y [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/). Las cuotas son de la cuenta y se reinician a medianoche UTC. Los contadores locales de WINT son indicadores, no sustituyen la medición de Cloudflare. Si se agota una cuota de D1, las consultas pueden fallar hasta el reinicio; no se promete disponibilidad ininterrumpida. No se habilita ningún plan de pago.

Los runners estándar de GitHub Actions son gratuitos para repositorios públicos según su [documentación de facturación](https://docs.github.com/en/billing/concepts/product-billing/github-actions). El workflow no usa runners grandes ni publica artefactos; solo escribe resúmenes de ejecución sin perfiles ni credenciales. Si el repositorio pasa a ser privado, hay que desactivar o revisar el workflow antes de ejecutarlo, pues cambia el régimen de cuotas. Las tareas [programadas de GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) pueden retrasarse y no sustituyen un SLA de actualización.
