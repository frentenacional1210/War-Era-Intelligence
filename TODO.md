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
- [x] Copia comprobada con `npm run backup` (exporta, restaura en SQLite y verifica) y procedimiento semanal documentado.
- [x] Actividad semanal observada (`/api/activity`) global en cobertura y por país en su ficha; tablas desplazables accesibles con teclado.

- [x] Interfaz por tareas, portada nueva y herramientas: ¿qué producir?, combate y predicción electoral con reglas oficiales y votos reales.

## Pendiente
- [ ] Proyección de batallas con `battle.getLiveBattleData`, `round.getById` y los puntos de ronda oficiales (`pointsToWinRound`, `tickPoints`); falta estudiar cómo se asignan los puntos por tramo.
- [ ] Calculadora de empresas y mejoras (`upgradesConfig`, `workOffer.*` para salarios reales) y planificador de habilidades por nivel de jugador.
- [ ] Validar el modelo de combate con daños reales observados (`battleRanking`, `round.getLastHits`) y ajustar la combinación.
- [ ] Verificar en producción tras la reanudación del 18 Oct (00:00 UTC): commits de 24 jugadores, hora de agotamiento del presupuesto, escrituras por registro y capturas evitadas, comparándolos con `artifacts/validation/write-budget-2026-10-17.json`.
- [ ] Traducir las explicaciones de eventos (`data_json.explanation`), que siguen en inglés en la vista detallada de alertas.
- [ ] Mejorar la interpretación de la IA, que es genérica con el modelo gratuito de 3B; valorar otro modelo de Workers AI dentro del presupuesto gratuito.
