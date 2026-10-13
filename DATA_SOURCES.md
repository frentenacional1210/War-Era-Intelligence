# Fuentes de datos de WarEra

WINT consulta la API pública tRPC de WarEra en `https://api2.warera.io/trpc/`. La [sonda reproducible](artifacts/probes/probe-results.json) del 11 de octubre de 2026 guarda formas, códigos y cabeceras, sin perfiles completos ni cuerpos de artículos. Las firmas candidatas se contrastaron con la [documentación de la API](https://api2.warera.io/docs/) y pruebas anónimas. Una respuesta anónima observada no garantiza disponibilidad o cuota futura.

| Fuente WINT | Procedimiento y captura | Alcance que puede afirmarse |
| --- | --- | --- |
| Países | `country.getAllCountries` y `country.getCountryById` | Descubrimiento de IDs y fichas; tres detalles por tick. La copia verificada conservaba 180 países. |
| Regiones | `region.getRegionsObject` y `region.getById` | Descubrimiento y detalles; tres por tick. No incluye geometrías cartográficas verificadas. |
| Jugadores | `user.getUsersByCountry` y lote tRPC de `user.getUserLite` | Cursores por país; cuatro perfiles por Cron directo u ocho por recolector compacto. Cobertura parcial y campos que puede omitir el perfil lite. |
| Partidos | `party.getManyPaginated` | Diez objetos candidatos por página; dirigentes y miembros solo cuando el objeto público los ofrece. Sin programas internos verificados. |
| Unidades militares | `mu.getManyPaginated` | Diez objetos por página; pertenencia observada, sin participación individual en batallas. |
| Batallas | `battle.getBattles({isActive:true})` y reconciliación acotada con `battle.getById` | Feed activo y verificación de fichas conocidas. La desaparición del feed se mantiene como estado desconocido hasta confirmación. |
| Artículos | `article.getArticlesPaginated({type:'last'})` | Archivo paginado y revisión de portada; se exige visibilidad y publicación públicas. Se guardan título, IDs y métricas permitidas, nunca cuerpo HTML. |
| Prensa analítica | Derivada de la tabla de artículos, sin llamada adicional a WarEra | `/api/press` toma hasta 100 metadatos recientes y calcula tendencias por fecha/palabras del título y relaciones de temas compartidos. Son etiquetas inferidas, no hechos comprobados ni contenido del artículo. |
| Mercados | `itemTrading.getPrices` | Precios globales por producto, sin volumen de operaciones ni liquidez nacional. Se conserva la última cotización aunque sea antigua. |
| Primeras órdenes públicas | `tradingOrder.getTopOrders` | Hasta cinco ofertas de compra y cinco de venta por producto observado; 24 productos con muestra en la medición remota del 13-10-2026. No son operaciones realizadas ni liquidez total. |
| Empresas | `company.getCompanies` y `company.getById` | Páginas y fichas públicas; país solo si la fuente lo indica expresamente. Cobertura aún por medir. |
| Elecciones | `election.getElections({countryId})` | Paginación por país; candidatos, estados y totales solo si constan en el objeto público. |
| Gobiernos | `government.getByCountryId` | Ficha por país cuando existe; cargos observados, no una cronología política completa. |
| Eventos y alertas | Reglas locales sobre capturas de las fuentes anteriores | No son una fuente oficial adicional. Transiciones con antes/después y hora de observación; título de artículo solo como metadato. |

El campo `source_url` identifica el procedimiento original. `updated_at` y `source.last_success` permiten evaluar antigüedad. Los IDs estables, tamaños de página y cursores se validan antes de avanzar; páginas repetidas o desalineadas se rechazan. El Cron y el recolector externo comparten bloqueos y presupuesto. Las respuestas de visitante proceden de D1, sin consulta upstream por vista.

La publicación de una página de artículos puede incluir registros `isPublic:false` o `isPublished:false` incluso sin autenticar: WINT los excluye, así como eliminados. Nunca procesa cuerpos o comentarios para la IA ni para alertas. Los chats, Discord y perfiles privados no se recogen sin contrato público permitido o autorización expresa.

Las capturas de entidades se crean cuando cambia el conjunto normalizado de campos. El mantenimiento guarda línea base y agregados antes de borrar detalle de más de 30 días; retiene agregados diarios 90 días, semanales un año y mensuales al menos dos años. Esto protege observaciones futuras y **no recupera datos antiguos que ya se borraron**. El libro de órdenes conserva solo la última muestra por producto, sin serie histórica. El archivo usa hasta veinte capturas y veinte precios por ejecución, presupuesto separado de 15.000 escrituras/día y techo conjunto de 95.000; la cuota real de la cuenta D1 incluye además otras operaciones. El 13 de octubre a las 16:33 UTC el presupuesto interno de recopilación tenía 79.793/80.000 escrituras reservadas, sin margen para otro turno; el reinicio siguiente es a las 00:00 UTC del 14. No se modifica para forzar capturas.

Los sondeos de throughput del 12 de octubre verificaron páginas de 20/50 candidatos y lotes tRPC ordenados, pero WINT usa lotes menores para CPU y D1. Los encabezados anónimos observados `ratelimit-*` y `Retry-After` se respetan como señales del servidor, no como un contrato de capacidad. Véanse [VALIDATION.md](VALIDATION.md) y [ARCHITECTURE.md](ARCHITECTURE.md).
