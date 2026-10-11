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

Cada minuto se atiende una sola fuente vencida, protegida por un bloqueo global y un bloqueo por fuente. El cursor avanza después de guardar el lote; reintentar no duplica entidades ni capturas idénticas. La reserva diaria de recopilación es de 60 000 escrituras estimadas, a razón de 140 por lote. Al agotarla se pausa hasta el siguiente día UTC. No representa el contador facturado de D1. Los errores conservan el último dato válido. El frontend mantiene su última respuesta válida y adapta el polling entre 90 y 180 segundos, suspendiéndolo cuando la pestaña está oculta. La API de lectura comparte caché y tiene un límite de 120 solicitudes por minuto por IP en cada ubicación de Cloudflare.

Los lotes son de tres entidades o un jugador. Países y regiones guardan sus IDs ordenados durante el primer descubrimiento de cada recorrido y consultan después las fichas individuales verificadas. Una comparación del cursor y de la próxima fecha al adquirir el bloqueo evita que una sincronización forzada concurrente use una selección antigua. Adquisición de bloqueos, reserva/registro de ejecución, datos/capturas y cierre usan transacciones separadas; el camino habitual realiza cinco llamadas D1 y respeta los límites por invocación.

## Economía

`shared/economics.ts` ofrece aritmética de escenarios con entradas editables. Ingresos diarios = unidades × precio; materias = unidades × coste de material; impuestos = ingresos × tasa introducida; beneficio = ingresos − materias − impuestos − salarios − costes fijos − coste de oportunidad. ROI diario = beneficio / inversión y amortización = inversión / beneficio cuando ambos valores son positivos. La comparación de ampliación resta beneficios y capital entre dos escenarios. La cadena productiva compara vender materia prima con transformarla según rendimiento, costes y precios dados por el usuario. Ninguna de estas ecuaciones se afirma como regla oficial de WarEra.

## Límites gratuitos verificados (11-10-2026)

| Servicio | Límite gratuito relevante |
| --- | --- |
| Workers | 100 000 solicitudes/día, 10 ms de CPU por solicitud HTTP, 50 subsolicitudes por invocación; Cron en la misma cuenta. |
| D1 | 500 MB por base, 5 GB por cuenta, 5 millones de filas leídas/día, 100 000 escritas/día y 50 consultas por invocación Free. |
| Workers AI | 10 000 neurons/día; en esta fase está desactivado. |

Fuentes: [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/), [límites de D1](https://developers.cloudflare.com/d1/platform/limits/), [precios/cuotas de D1](https://developers.cloudflare.com/d1/platform/pricing/) y [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/). Las cuotas son de la cuenta y se reinician a medianoche UTC. Los contadores locales de WINT son indicadores, no sustituyen la medición de Cloudflare. Si se agota una cuota de D1, las consultas pueden fallar hasta el reinicio; no se promete disponibilidad ininterrumpida. No se habilita ningún plan de pago.
