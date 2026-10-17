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
- [x] Seguimiento local de hasta 20 registros con cambios campo a campo desde la última visita.
- [x] Carga diferida de gráficos: la portada pasa de unos 712 KB a unos 365 KB de JavaScript.
- [x] Auditoría axe WCAG 2.1 A/AA en 11 páginas (escritorio y móvil) sin infracciones graves; contraste corregido.
- [x] Resumen diario «Hoy en WarEra» (`/hoy` y `/api/today`).
- [x] Alerta operativa en administración (recolector sin commits, tasa de errores), sin culpar las pausas de cuota.
- [x] Actividad semanal observada (`/api/activity`) global en cobertura y por país en su ficha; tablas desplazables accesibles con teclado.

## Pendiente
### Experiencia de usuario

### Análisis

### Operación
- [ ] Procedimiento de copia periódica documentado y comprobado.
