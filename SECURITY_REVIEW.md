# WINT route and Free-tier quota review — 2026-10-12

Scope: new AI, history-maintenance, ingestion, collector, and derived-alert paths. This is a source-code and local SQLite review; no production D1 or paid service was called. Cloudflare's published limits are [D1 Free 100,000 rows written and 5 million rows read per day](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers Free 10 ms CPU per HTTP/Cron invocation](https://developers.cloudflare.com/workers/platform/limits/). D1 charges indexed writes in addition to row writes, so SQLite's `changes` count is not a substitute for live D1 `meta.rows_written`.

## High priority

### SR-01 — Rejected rate-limited requests still write to D1 (fixed)

- **Location:** `worker/auth.ts:21–30` (`takeLimit`); `worker/index.ts:168–171` (AI route).
- **Original evidence:** the conflict action incremented `hits` for every request, even after `max` was reached, then checked `row.hits <= max`. The AI route invoked it before checking whether AI was disabled.
- **Impact before fix:** an unauthenticated client with the public CSRF header could burn D1 Free writes through rejected requests.
- **Fix applied by the route owner:** `worker/auth.ts` now conditions the atomic conflict update on `reset_at<=now OR hits<max`, returning no row for an exhausted bucket. `worker/index.ts` checks the disabled AI gate before actor write reservations. `tests/auth.test.ts` verifies concurrent last-slot requests and unchanged SQLite `total_changes()` after repeated rejection.

### SR-02 — Ingestion reservation needed to cover alert fan-out (fixed provisionally; live calibration pending)

- **Location:** `worker/ingestion.ts:310,396–405`; `migrations/0011_alerts.sql:141–195`; `migrations/0008_coverage.sql:30–46`.
- **Evidence:** a single changed player can update five player indexes, insert an indexed snapshot, trigger three event rows and three alert rows, and update coverage, daily stats, and source counters. A rough upper estimate exceeds 50 D1 row writes for that player before fixed bookkeeping. D1 explicitly counts indexed-column updates as additional writes.
- **Fix applied by the ingestion owner:** `worker/ingestion.ts` now reserves `140 + 70 * playerRowLimit` for players and `140 + 35 * rowLimit` for other sources, then refunds only from complete D1 metadata. Calibrate with a bounded real D1 capture containing three player transitions and inspect every result's `meta.rows_written`; keep a larger margin if any row exceeds the estimate. The remaining 5,000-account-write margin is a cushion, not a proof of safety.
- **Uncertainty:** Cloudflare documents a minimum added write for indexed columns, not an exact trigger/index multiplier, so this is an engineering safety estimate rather than a formal maximum.

## Medium priority

### SR-03 — Price-archive eligibility can scan beyond the read reserve (open)

- **Location:** `worker/history.ts:49–56`; `worker/history-maintenance.ts:97–108`.
- **Evidence:** `LIMIT 21` and `LIMIT 1001` constrain eligible rows returned, while `EXISTS(newer...)` may walk many expired latest quotes that are deliberately retained. The timestamp index does not bound rows inspected before finding enough eligible old prices.
- **Impact:** a maintenance invocation can read much more than its 10,000-row reservation and surprise the D1 daily read budget; the diagnostic probe runs after archival, so it cannot prevent that invocation's reads.
- **Fix:** bound the *candidate* set before checking whether a newer quote exists, persist a cursor over `(captured_at,id)` for fair backlog progress, and expose lower-bound backlog estimates. Check live `meta.rows_read` and pause/proportionally reduce maintenance when the read headroom is low. Preserve each item's latest raw quote.

### SR-04 — Free Worker CPU remains unverified on large pages (open operational validation)

- **Location:** `worker/ingestion.ts:113–145` (normalization, hashing, JSON page), `worker/history.ts:57–119` (rollup payload), `worker/ai.ts:171–216` (facts and prompts).
- **Evidence:** Free HTTP and Cron Workers have 10 ms CPU, excluding time spent waiting for D1 or Workers AI. Local Vitest wall time does not model isolate CPU time.
- **Impact:** a large collected page or history plan can terminate with Worker error 1102 after taking a quota reservation. The conservative retained reservation prevents further quota overspend but may reduce throughput.
- **Fix:** validate worst permitted page size under `wrangler dev`/Cloudflare preview and inspect CPU duration and `exceededCpu`; reduce batch size if needed. Keep ingestion and maintenance as separate invocations.

### SR-07 — Admin model validation bypassed the inference ledger (fixed)

- **Location:** `worker/index.ts:121–126`.
- **Original evidence:** the authenticated validation route called `env.AI.run` directly without reserving neurons in `ai_daily_budget`.
- **Fix applied:** the route now calls exported `reserveInference` immediately before the model probe, reserving the same conservative 120 neurons as public queries. It remains authenticated, CSRF-protected, limited to three attempts per actor per hour, and capped at 32 output tokens. `tests/api.test.ts` asserts the ledger is charged before the stubbed provider runs.

### SR-08 — Strategic report can scan large country tables (index mitigation applied; remote cost pending)

- **Location:** `worker/strategy.ts:12–18`; `migrations/0001_initial.sql:94–104`; `migrations/0010_intelligence.sql:16–19`.
- **Evidence:** the report counts `companies WHERE country_id=?` and active `battles WHERE country_id=?`, and fetches country-filtered events/articles. These patterns lacked country-leading indexes in the initial schema.
- **Mitigation applied:** migration `0014_strategy_indexes.sql` adds country-leading indexes for companies, active battles, events and articles; the migration was applied remotely. The indexed tables were still small when observed (companies 0, events 0, articles 482, battles 42), so the one-time index-build charge was limited.
- **Residual risk:** distinct country URLs bypass same-URL edge cache. Verify `EXPLAIN QUERY PLAN` and D1 `meta.rows_read` with larger tables; if country counts grow materially, bounded/materialized counters may be needed. No production-scale read estimate is claimed.

The 13 October remote status later counted 57 companies, 133 events, 1,734 articles and 71 battles. Those totals remain small enough that the initial index check does not establish large-scale query cost. The ingestion ledger had 79,793/80,000 writes reserved and paused until the next UTC reset; this was not bypassed.

## Fixed in this review

### SR-05 — Derived-source switches now stop writes

`migrations/0011_alerts.sql:30–243` now guards every derived event trigger with `source_registry.events.enabled` and the alert copy trigger with `source_registry.alerts.enabled`. Because migration 0011 was already applied remotely, `migrations/0013_alert_source_switches.sql` replaces those existing triggers without deleting event or alert rows. `tests/alerts.test.ts` verifies independent on/off behavior across actual snapshot writes. The initial migration enables both sources intentionally; later admin disable now takes effect after 0013 is applied.

### SR-06 — AI request body and model scope are bounded

`worker/ai.ts` streams the POST body and stops at 4,096 bytes even without `Content-Length`; `tests/ai.test.ts` covers a chunked oversized body. `migrations/0012_ai.sql` starts disabled, and `aiStatus` requires **all three**: `AI_ENABLED='true'`, `ai_config.enabled=1`, and a live `AI` binding. The public route applies same-origin CSRF and actor limits before `aiRoute`. Model plans select only validated fixed public tools; canonical census/events/prices requests use fixed tools and reserve inference for interpretation. Article body is not read. At most two model calls each have a full-message 7,000 UTF-8-byte bound and 512 output-token cap; a 120-neuron atomic daily reservation precedes inference. The public census route was enabled after a valid free-tier provider probe and tested live at 19:39:45 UTC.

## Validation

Local SQLite migrations, TypeScript check, build and OpenAPI generation passed after the AI and press changes. The suite passed 125/125 tests in 20 files at that release, then 126/126 after the `strategy` ID fix. The observed remote maintenance call archived no eligible rows and reported four D1 rows written and seventeen read. These checks do not measure worst-case live D1 indexed-write metadata or Cloudflare isolate CPU time. The initial provider probe returned 503 because the binding returned structured `{response:object}`; a later administrative probe returned 200, `available=true`, `responseKind=object`. The first public query returned facts without interpretation; after the planning fix, [a real public census query](artifacts/validation/ai-live.json) returned 15 facts, one citation and a separate interpretation with `ai.available=true`. A [real `strategy` query](artifacts/validation/ai-strategy-live.json) on version `7147d878` returned one fact and one citation, while rejecting the model interpretation as invalid (`ai.available=false`). Market history and press AI tools still need separate live observation. The restored private SQL backup passed integrity and foreign-key checks without changing production.
