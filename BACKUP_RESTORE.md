# Copia y recuperación sin reinicializar producción

Antes de las migraciones de continuidad se exportó la D1 existente y se restauró el SQL en una base SQLite en memoria. Se comprobaron integridad, claves foráneas y contadores de once tablas, incluidos cursores y capturas. Evidencia pública sin contenido ni credenciales: `artifacts/validation/backup.json`. El SQL permanece bajo `artifacts/private/backups/`, excluido de Git y con permisos restringidos al usuario y SYSTEM.

Para futuras copias, ejecutar Wrangler desde la raíz y capturar su salida en un archivo privado: la salida puede incluir un enlace firmado de descarga. La exportación puede bloquear brevemente las consultas de la base. Utilizar un nombre de archivo nuevo; no sobrescribir la copia anterior.

```powershell
npx wrangler d1 export wint-db --remote --output artifacts/private/backups/fecha-descriptiva.sql *> artifacts/private/backups/export-private.log
python scripts/verify-backup.py artifacts/private/backups/fecha-descriptiva.sql
```

Las migraciones son incrementales y se prueban primero con SQLite y D1 local. No ejecutar `DROP`, recrear D1 ni importar una copia sobre producción como parte de una migración normal. Si falla un despliegue, volver al Worker anterior compatible y conservar las tablas añadidas; los datos nuevos no se eliminan para simular una reversión.

Cloudflare proporciona [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) durante siete días en el plan gratuito. Antes de una recuperación real, guardar una nueva copia del estado presente, identificar el instante/bookmark correcto y comprobar el alcance del incidente. El procedimiento excepcional de restauración requiere autorización explícita porque revierte escrituras legítimas posteriores al instante elegido. No se ha ejecutado una restauración de producción.

La copia privada puede usarse para preparar un ensayo aislado de recuperación y comparar contadores/IDs sin revelar sesiones. No publicarla como artefacto de Actions ni habilitar un endpoint de descarga anónimo.
