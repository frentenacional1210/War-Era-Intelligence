# Históricos de WINT

La vista pública `/historicos` permite buscar y comparar hasta cuatro entidades del mismo tipo: jugadores, partidos, unidades militares, países, regiones, batallas, mercados, empresas, elecciones y gobiernos. Las fichas individuales conservan su explorador histórico. Los datos proceden de capturas públicas guardadas por WINT; no reconstruyen fechas anteriores a su primera observación.

Se puede elegir una medida, un periodo de siete días a dos años, fechas UTC personalizadas y resolución de capturas individuales, diaria, semanal o mensual. Las medidas numéricas se representan en gráficos y los cambios de país, pertenencia, cargos o estado se consultan en la secuencia de observaciones. Cada serie muestra su primera captura disponible, huecos, metodología y fuente de la ficha. Las fechas son observaciones de WINT, no prueba de cuándo comenzó un cargo o ocurrió un cambio.

Cuando una serie supera la página de 200 puntos, el botón de más capturas sigue el cursor de la API. Las exportaciones CSV y JSON incluyen únicamente las páginas cargadas de las entidades seleccionadas, con sus fechas y metodología; no son una descarga de toda la base. El CSV protege celdas que podrían interpretarse como fórmulas. Los periodos sin observaciones no se rellenan, ni se interpreta un campo ausente como cero.

## API pública

`GET /api/history?resource=players&id=ID&period=30d` mantiene el contrato anterior y añade paginación y metadatos de metodología. También admite HEAD y OPTIONS, y lectura entre orígenes sin sesión ni clave. La consulta no realiza inferencia ni pide información nueva a WarEra.

| Parámetro | Valores |
| --- | --- |
| `resource` | Uno de los diez tipos enumerados arriba, usando los IDs de API: `players`, `parties`, `military-units`, `countries`, `regions`, `battles`, `markets`, `companies`, `elections`, `governments`. |
| `id` | ID real de una entidad capturada. |
| `period` | `7d`, `30d`, `90d`, `1y`, `2y`; por defecto `30d`. |
| `grain` | `raw`, `day`, `week`, `month`; si se omite, se elige según el periodo. |
| `from`, `to` | Fecha `YYYY-MM-DD` o ISO UTC exacta `YYYY-MM-DDTHH:mm:ss.sssZ`. Un `to` de día incluye ese día completo. Ventana máxima de cinco años; la conservación efectiva se describe abajo. |
| `limit` | De 1 a 200 puntos, por defecto 200. |
| `cursor` | Token opaco devuelto por la API; debe mantenerse el recurso, entidad, intervalo y resolución. |

La respuesta contiene `points`, `gaps`, `baseline`, `truncated`, `archive_pending`, `boundaryLimited`, `nextCursor`, `nextUrl`, `methodologyVersion: "2"` y `retention`, además del recurso, ID, fechas y resolución. Solicite `nextUrl` hasta que sea `null` para recorrer el intervalo completo. Los enlaces son relativos al mismo origen y fijan la ventana temporal para las páginas siguientes. La ordenación de capturas individuales utiliza fecha e ID interno para conservar observaciones con la misma fecha sin repetirlas.

Cada punto comunica fecha observada, primera fecha del intervalo, principio del intervalo, métricas seleccionadas, número de capturas, método y procedencia `raw`, `rollup` o `mixed`. Una línea base tiene procedencia `baseline`. La fuente de la respuesta (`sourceUrl`, `sourceMeaning: "current-entity-source"`) corresponde a la ficha actual: las capturas antiguas no almacenaron una URL propia y no se les atribuye retroactivamente una.

Un resumen usa el último valor observado y cuenta las capturas conservadas, sin promediar ni sumar métricas. Los recuentos de un intervalo archivado pueden incluir observaciones anteriores a un `from` personalizado. Si su última observación está después de `to`, se omite ese resumen y se señala `boundaryLimited`: no puede reconstruirse el valor exacto de ese límite a partir de un resumen. Las capturas individuales pendientes de archivo permanecen consultables y se combinan con los resúmenes sin duplicar su recuento. La selección `raw` muestra el detalle aún conservado; para cambios ya compactados deben usarse los resúmenes.

## Conservación y seguridad del archivo

| Resolución | Conservación prevista |
| --- | --- |
| Capturas individuales | 30 días; los cambios vencidos esperan su archivo seguro. |
| Resúmenes diarios | 90 días. |
| Resúmenes semanales | 366 días. |
| Resúmenes mensuales | Al menos 24 meses, conservando el intervalo que cruza el límite. |
| Primera captura disponible | Durante la vida de la entidad. |

El mantenimiento conserva línea base y resúmenes antes de borrar únicamente los IDs individuales incluidos en esa misma transacción. Una transacción fallida conserva las filas originales. Los planes repetidos no duplican observaciones; la migración incremental `0016_history_ordering.sql` permite resolver empates de fecha entre lotes. Los resúmenes anteriores sin ID recuperable mantienen su valor registrado en un empate.

Se mantiene la última cotización global de cada producto aunque sea antigua. Los tipos desconocidos y las capturas malformadas o sin métricas proyectables conservan su detalle para revisión. El mantenimiento respeta su bloqueo y presupuesto separado, sin reiniciar cuotas de recopilación. La conservación depende del almacenamiento y presupuesto disponibles y no garantiza que se hayan capturado todos los cambios del juego.

La exploración de candidatos usa el índice por fecha y un cursor persistente. Un lote examina como máximo 1.000 candidatos y continúa en el siguiente; las filas que no puedan proyectarse permanecen intactas y no bloquean las capturas válidas posteriores. El cursor avanza en la misma transacción del archivo y retrocede si esa transacción falla.

La copia SQL privada previa a la migración se verifica restaurándola en SQLite aislado; nunca se restaura producción durante las comprobaciones rutinarias. Las pruebas de envejecimiento y archivo usan SQLite de prueba. No se cambian fechas reales para simular antigüedad en la base pública.
