# Lista de tareas de mejora

Creada el 17 de octubre de 2026 a partir de la propuesta priorizada. Se marca una tarea solo cuando está implementada, probada, publicada y verificada.

## Hecho
- [x] Liquidación de reservas en ejecuciones fallidas y cesión del cron al recolector (`bd326ef`).
- [x] Telemetría `writeUsage` por fuente en administración.
- [x] Aviso global de frescura de datos (`e5416f7`).
- [x] Capturas históricas solo en cambios relevantes de jugadores y artículos (`80b7324`).
- [x] Copia nueva restaurada en SQLite y migración 0017 aplicada.
- [x] Recolector con 24 jugadores por commit y lotes de 8 hacia WarEra, sondeado en real.
- [x] IA: resolución por nombre, respuesta en español con reintento y banco de 22 preguntas de regresión.
- [x] Títulos de acontecimientos y alertas en español en toda la interfaz.
- [x] Ficha de país conectada con diez bloques enlazados e informe estratégico.

## Pendiente
### Experiencia de usuario
- [ ] Panel de seguimiento de favoritos con sus cambios desde la última visita.
- [ ] Carga diferida de la librería de gráficos.
- [ ] Revisión de accesibilidad automatizada en las páginas principales.

### Análisis
- [ ] Resumen diario «Hoy en WarEra».
- [ ] Tendencias semanales de actividad observada por país.

### Operación
- [ ] Alerta en administración si el recolector de GitHub deja de confirmar páginas o aumentan los errores.
- [ ] Procedimiento de copia periódica documentado y comprobado.
