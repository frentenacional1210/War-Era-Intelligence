# WarEra Intelligence (WINT)

Plataforma independiente de consulta de datos públicos de WarEra. La arquitectura es un Worker de Cloudflare con la aplicación React como assets estáticos, D1 para datos compartidos y un Cron Trigger para la recopilación incremental. Los navegadores consultan la API WINT; no ejecutan la recopilación. Los datos visibles deben proceder de la API pública verificada o de una importación administrativa identificada. Los módulos sin fuente o sin capturas muestran ese estado.

**Web pública:** https://warera-intelligence.warera-intelligence.workers.dev · [API de salud](https://warera-intelligence.warera-intelligence.workers.dev/api/health) · [OpenAPI](https://warera-intelligence.warera-intelligence.workers.dev/openapi.json).

**Código:** https://github.com/frentenacional1210/War-Era-Intelligence. Se conserva la licencia [AGPL-3.0](LICENSE) del repositorio de destino.

Cloudflare está autenticado y el Worker, la base D1 remota y el Cron están desplegados. Ocho fuentes públicas ya han guardado datos reales. El censo inicial es parcial y avanza por lotes; los contadores describen únicamente registros capturados. El acceso a `/admin` está en `artifacts/private/ADMIN_ACCESS.txt` en la máquina de entrega, excluido de Git. No publique ese archivo. Consulte [VALIDATION.md](VALIDATION.md) para pruebas y límites de la entrega.

## Arranque local

Requisitos: Node.js 22 o superior y npm. Desde la raíz del repositorio:

```powershell
npm install
$env:WINT_ADMIN_PASSWORD='una-contraseña-larga-y-única'
node scripts/admin-password.mjs --local
Remove-Item Env:WINT_ADMIN_PASSWORD
npm run db:migrate
npm run build
npm run dev:worker
```

Abra `http://127.0.0.1:8787`. `npm run dev` inicia Vite por separado para desarrollo visual, pero el Worker en el puerto 8787 sirve la web y la API juntas. Las credenciales locales están en `.dev.vars`, excluido de Git. `WARERA_API_KEY` es opcional y solo debe añadirse allí cuando exista autorización para usarla. Nunca use una variable `VITE_*` para secretos.

Comprobaciones: `npm run check`, `npm test`, `npm run build` y `curl http://127.0.0.1:8787/api/health`. `npm run test:e2e` ejecuta pruebas de navegador cuando están configuradas. La sincronización manual usa una sesión administrativa:

```powershell
$env:WINT_ADMIN_PASSWORD='la-contraseña-configurada'
npm run sync
Remove-Item Env:WINT_ADMIN_PASSWORD
```

## Importar recopilaciones propias

El importador acepta CSV, JSON y ZIP con hasta diez archivos CSV/JSON. El tamaño de entrada y el contenido descomprimido están limitados a 1 MB, con un máximo de 500 registros y 8 KB por registro; se rechazan rutas peligrosas y entradas cifradas. Seleccione `players`, `parties` o `military-units`. Los registros necesitan un ID de origen (`id`, `_id`, `userId`, `playerId`, `partyId`, `unitId` o `militaryUnitId`) y un nombre (`name`, `username`, `displayName` o `title`). `countryId` o `country` se normalizan a `country_id` solo cuando aportan un ID simple. Solo se guardan campos públicos de juego permitidos: ID, nombre, país, nivel, experiencia, actividad observable, afiliación, dirigentes y estadísticas numéricas explícitas. Los metadatos desconocidos se descartan; campos de credenciales o contacto como contraseñas, tokens, correo, teléfono y dirección provocan un error sin mostrar su valor. Revise la vista previa normalizada antes de confirmar. Para históricos con otros esquemas hará falta ampliar el mapeo de forma explícita.

```powershell
npm run import -- --file .\censo.csv --resource players
$env:WINT_ADMIN_PASSWORD='la-contraseña-configurada'
npm run import -- --file .\censo.csv --resource players --apply
Remove-Item Env:WINT_ADMIN_PASSWORD
```

La primera orden solo imprime el resumen y hasta 500 registros para revisión. `--apply` autentica, envía una vista previa al servidor y confirma lotes de diez. Un duplicado idéntico se omite; un mismo ID con datos distintos se informa como error y detiene la CLI. La base de datos usa inserción sin sobrescritura: una importación no reemplaza registros ya recogidos de WarEra. El panel de administración también admite archivos y confirmación. El origen aparece identificado como importación administrativa.

## Estado de la primera fase

El código incluye migraciones D1, API de consulta, recopilador programado, panel público y administración mínima, publicados y probados en la URL indicada. No se presentan los módulos posteriores como terminados: IA generativa, integración de Discord, mapas históricos, modelos predictivos y análisis estratégico figuran en [ROADMAP.md](ROADMAP.md). Las fórmulas del simulador son escenarios editables, no mecánicas confirmadas de WarEra.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md), [DEPLOYMENT.md](DEPLOYMENT.md), [API.md](API.md) y [DATA_SOURCES.md](DATA_SOURCES.md) para contratos, fuentes y puesta en producción.
