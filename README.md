# WarEra Intelligence (WINT)

WINT consulta y conserva datos públicos observados de WarEra. Un Cloudflare Worker sirve la web React y la API; D1 guarda entidades, capturas, agregados y estado de los recolectores. Las visitas leen D1: no lanzan consultas a WarEra. La cobertura es parcial y una ausencia en WINT no demuestra una ausencia en el juego.

**Web:** https://warera-intelligence.warera-intelligence.workers.dev · **JSON público para Grok:** https://warera-intelligence.warera-intelligence.workers.dev/api/data ([cómo recorrerlo](PUBLIC_DATA_API.md)) · [API](API.md) · [OpenAPI](public/openapi.json) · [estado y evidencia](VALIDATION.md). Código: https://github.com/frentenacional1210/War-Era-Intelligence, licencia [AGPL-3.0](LICENSE).

**Históricos:** [/historicos](https://warera-intelligence.warera-intelligence.workers.dev/historicos) reúne los diez recursos observados, compara hasta cuatro entidades y permite seleccionar periodos, fechas y resolución, cargar páginas adicionales y exportar CSV/JSON. La API conserva los campos públicos, la primera captura, los huecos y la metodología; [contrato y conservación](HISTORY.md).

Hay directorios, búsqueda, cobertura por país, fichas, relaciones observadas, elecciones y gobiernos públicos, batallas, empresas, hemeroteca de metadatos, precios, alertas derivadas, comparadores, históricos, escenarios económicos e informe estratégico descriptivo. Cada módulo depende de capturas reales y expone huecos; no hay censo global verificado ni datos anteriores a las capturas disponibles. El libro público de órdenes ya tiene 24 productos con muestra, sin que ello demuestre ventas ni liquidez total. **La IA pública está activada y se verificó una consulta real de «censo»**, con hechos observados, cita e interpretación acotada. Otras consultas y fuentes siguen dependiendo de sus datos y pruebas. Los programas internos de partidos, participantes individuales en batallas y liquidez nacional aún no están disponibles. Consulte la [tabla de cobertura funcional y pendientes](IMPLEMENTATION_GAPS.md).

La recopilación programada se reparte entre Cron y GitHub Actions. Un mantenimiento separado archiva observaciones antiguas antes de retirar detalle: detalle reciente durante 30 días, agregados diarios durante 90, semanales durante un año y mensuales durante al menos dos años, más la primera línea base disponible. El archivo no recupera datos borrados anteriormente. Las fuentes y métodos están en [DATA_SOURCES.md](DATA_SOURCES.md).

La medición remota del 13 de octubre de 2026 a las 16:33 UTC registró 3.049 jugadores, 1.734 artículos, 180 países y 24 productos con muestra de primeras órdenes. El censo había empezado en los 180 países; 58 tenían al menos una pasada completa y 122 seguían en curso. Son **registros capturados**, no el universo del juego. El presupuesto interno diario de recopilación tenía 79.793 de 80.000 escrituras reservadas, insuficientes para otro turno; el siguiente reinicio es el 14 de octubre a las 00:00 UTC (02:00 en Madrid). No se reinician reservas manualmente. La cuota real de D1 también incluye otras operaciones de la cuenta. La copia privada del día 12 verificó cifras anteriores, sin restaurar producción; [VALIDATION.md](VALIDATION.md) separa ambas evidencias.

## Desarrollo local

Requiere Node.js 22 y npm. Desde este directorio:

```powershell
npm install
npm run db:migrate
npm run check
npm test
npm run build
npm run dev:worker
```

Abra `http://127.0.0.1:8787`. `npm run dev` inicia Vite por separado para trabajo visual. Para acceso administrativo local genere `ADMIN_PASSWORD_HASH` y `SESSION_SECRET` con `node scripts/admin-password.mjs --local`; las credenciales quedan en `.dev.vars`, excluido de Git. `WARERA_API_KEY` es opcional y solo se configura si existe autorización para usarla. Nunca use `VITE_*` para secretos.

La sincronización manual usa una sesión administrativa y consume cuotas: `npm run sync` con `WINT_ADMIN_PASSWORD` en el entorno. No la utilice para eludir un presupuesto diario agotado. La importación CSV/JSON/ZIP admite hasta 500 registros en vista previa y lotes de diez de jugadores, partidos o unidades; valida campos públicos y no reemplaza filas existentes. Véase [API.md](API.md) para el contrato y [DEPLOYMENT.md](DEPLOYMENT.md) para operar una instalación.

El trabajo pendiente y su prioridad están en [ROADMAP.md](ROADMAP.md). [ARCHITECTURE.md](ARCHITECTURE.md) explica presupuestos, aislamiento del mantenimiento y límites gratuitos. Las fórmulas económicas son escenarios con entradas explícitas, no mecánicas oficiales confirmadas de WarEra.
