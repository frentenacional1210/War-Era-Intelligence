# Arquitectura

```text
API pública WarEra ──► Cron Worker / GitHub Actions ──► Worker de ingestión ──► D1
                                                                  │
                                              mantenimiento histórico separado
                                                                  │
Navegador ──► Worker: API pública de lectura ──► D1 ──► React/Vite
                   └─► API administrativa y recopilador autenticados
```

Un único Worker sirve `dist/` y `/api/*`. `worker/ingestion.ts` conserva cursores, bloqueos, presupuesto y resultados de cada fuente. La API pública lee la copia compartida de D1 y no llama al origen por visitante. Los objetos conservan IDs externos, columnas consultables, procedencia y campos públicos seleccionados en `data_json`. Las capturas nacen al cambiar los datos normalizados: una observación repetida no crea una variación ficticia. La hora de captura no equivale necesariamente a la hora del suceso.

El Cron está declarado cada minuto. Alterna un turno de mantenimiento por cada diez minutos y usa los demás turnos para fuentes vencidas; GitHub Actions complementa la captura de páginas grandes cada quince minutos y puede retrasarse. Ambas vías de ingestión comparten cursores, bloqueos y presupuesto. Jugadores rotan por cursores independientes de país; artículos separan revisión de portada y continuación del archivo. Las respuestas se reducen a campos públicos necesarios antes de escribir. Si una fuente falla, sus filas previas siguen consultables con antigüedad y error de fuente. Ninguna ejecución promete completar un país o el mundo entero.

La ingestión reserva escrituras antes de llamar al origen. Su presupuesto interno es de 80.000 escrituras diarias: 140 por turno más 70 por jugador o 35 por fila de otra fuente, con reembolso tras recibir `meta.rows_written` completo de D1. Ante fallo o metadatos incompletos conserva la reserva. El mantenimiento histórico usa invocación, bloqueo y contador separados: hasta veinte capturas y veinte precios por lote, reserva máxima 720 escrituras y 10.000 lecturas por invocación, 15.000 escrituras y un millón de lecturas diarios. La suma de reservas de ingestión y mantenimiento se limita a 95.000 escrituras/día para dejar margen a otras operaciones. Es contabilidad interna conservadora; las cuotas oficiales son por cuenta y D1 cuenta también escrituras de índices. El 13 de octubre a las 16:33 UTC la ingestión tenía 79.793/80.000 reservadas y quedó pausada hasta el reinicio automático del 14 a las 00:00 UTC; no se reinicia manualmente el contador.

El mantenimiento archiva por IDs exactos en una transacción y solo elimina detalle protegido por agregados. Preserva la primera línea base y la última cotización de cada producto. Retiene detalle 30 días, agregados diarios 90 días, semanales un año y mensuales al menos dos años. Una serie puede tener huecos, antigüedad y archivo pendiente; no se inventan puntos anteriores al inicio de las capturas. El diagnóstico del backlog está acotado, aunque el coste de lectura de precios antiguos requiere medición remota ([SR-03](SECURITY_REVIEW.md)).

La API pagina colecciones hasta 50 filas, parametriza valores y valida ordenaciones e IDs. El contador por fuente y las tablas de cobertura evitan recuentos globales frecuentes; los índices nacionales de la migración 0014 cubren consultas descriptivas de estrategia. Las rutas derivadas —alertas, relaciones, política y estrategia— transforman solo datos recogidos. Las alertas registran cambios observados, no predicciones. `shared/economics.ts` calcula escenarios con parámetros introducidos por el usuario; ningún resultado afirma una regla oficial no verificada.

La hemeroteca `/api/press` y `/prensa` usa exclusivamente columnas de metadatos de artículos ya guardados. Un SELECT acotado toma hasta cien fichas recientes para país y fechas; el idioma se filtra dentro de esa muestra. Tendencias y relaciones se calculan de fechas y palabras del título, sin cuerpo ni análisis del contenido, y no representan el archivo completo.

La migración 0015 añade una fuente independiente de primeras órdenes públicas. Su cursor recorre productos ya presentes en el catálogo, toma una sola muestra por producto, proyecta como máximo cinco ofertas por lado y guarda solo la última observación. `/api/markets/orderbook` consulta D1 y devuelve `pending` para un producto aún sin muestra; no llama al origen. En la medición remota del 13 de octubre había 24 productos con muestra. La presencia de una muestra no acredita transacciones ni liquidez total.

La administración usa hash PBKDF2-SHA256, sesiones firmadas guardadas en D1, cookie HttpOnly/SameSite Strict y comprobación de origen/CSRF en mutaciones. El recolector automático tiene su propio secreto Bearer. Los límites por actor se aplican antes de trabajos costosos sin escribir por solicitudes ya rechazadas. La IA activada tiene herramientas SQL fijas de solo lectura; no acepta SQL generado ni lee cuerpos de artículos. El catálogo incluye histórico de mercados, estrategia de hasta dos países y prensa acotada a veinte metadatos de una muestra reciente; los IDs deben aparecer en la pregunta. Una consulta pública real de «censo» produjo 15 hechos, una cita y una interpretación tras validar el binding/modelo gratuito. Cada consulta reserva 120 neuronas antes de inferir, hasta 5.000 al día (41 reservas enteras), y limita prompts y salida. La validación administrativa también reserva 120. Esa prueba no garantiza respuestas válidas para otras preguntas o fuentes sin filas.

| Servicio gratuito | Límite relevante y efecto |
| --- | --- |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 100.000 filas escritas y 5 millones leídas por día, cuota de cuenta. Índices y triggers incrementan el coste. |
| [Workers](https://developers.cloudflare.com/workers/platform/limits/) | 10 ms de CPU por solicitud HTTP/Cron Free; la CPU real de páginas grandes debe medirse en producción. |
| [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | 10.000 neuronas/día Free; WINT limita internamente a 5.000 y activó su ruta pública tras la prueba real. |

Estos límites son externos y pueden cambiar. GitHub Actions en repositorio público usa runners estándar, pero sus tareas [programadas pueden retrasarse](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). Véanse [VALIDATION.md](VALIDATION.md) y [SECURITY_REVIEW.md](SECURITY_REVIEW.md) para evidencia y riesgos no resueltos.
