# OMP store inventory — GPT-5.6 Sol corpus

**Source ID prefix:** `OMP-` (stable within this inventory). Scope is the MacBook OMP stores under `/Users/jamie/.omp` plus the current project-local corpus area. Read-only inventory; no transcripts copied.

## Sources

| Source ID | Exact path | Format / contents | File/row counts | Date range | Sol candidates |
|---|---|---|---:|---|---|
| OMP-001 | `/Users/jamie/.omp/agent/sessions/` | Session JSONL roots; each root has a primary session JSONL and optional child-agent JSONL/MD/tombstones | 13,862 files (recursive; includes all JSONL and companion artifacts) | Primary sampled session `2026-08-28T11:57:04.795Z`; session records contain timestamps | Yes; primary record explicitly `cli-proxy/codex.gpt-5.6-sol.manager` with `resolvedModelIsFallback:false`; child files include current Sol-corpus agents |
| OMP-002 | `/Users/jamie/.omp/agent/history.db` | SQLite: `history` (6,644 rows), FTS shadow tables, `session_titles` (301 rows) | 6,644 history rows; Sol/GPT-5.6 text match: 479 rows / 219 distinct session IDs | 2026-08-01 05:51:05 through 2026-08-28 12:47:12 for matching rows | Prompt text matches `gpt-5.6`, `gpt56`, or `sol`; authoritative fields are `created_at`, `cwd`, `session_id`, `prompt` |
| OMP-003 | `/Users/jamie/.omp/agent/agent.db` | SQLite operational store | Tables include `usage_history` 5,475 rows; `usage_cost_history` 30,926 rows; `client_usage` 0 rows; plus jobs, threads, model_perf, auth metadata | Usage tables have recorded timestamps; exact extrema not required to identify Sol sessions | Model/cost/account usage is available, but no populated client_usage rows in this snapshot |
| OMP-004 | `/Users/jamie/.omp/agent/models.db` | SQLite model cache (`model_cache`) | 1 table | Cache timestamped by `updated_at` | Provider model catalog/cache; attribution source, not session event log |
| OMP-005 | `/Users/jamie/.omp/benchmarks/omp-benchmarks.sqlite` | SQLite benchmark DB | Tables: runs, actors, events, measurements, tool_calls, artifacts, corrections, verdict_receipts, pricing tables; actor rows with Sol/GPT-5.6 attribution: 1,127 actors / 1,115 sessions | Sol/GPT-5.6 actor range `2026-08-23T07:39:25.198Z`–`2026-08-28T03:51:11.170Z` | Strongest authoritative route/role/fallback/outcome source |
| OMP-006 | `/Users/jamie/.omp/reviews/` | Markdown review ledgers and records | 2,063 files | Historical review corpus; paths are individually dated/IDed where applicable | Review text contains Sol investigations and outcome evidence; do not classify transcript quality |
| OMP-007 | `/Users/jamie/.omp/logs/` | OMP log text + JSONL audit files | 1,605 files | Includes `omp.2026-08-28.*` and `omp.2026-08-29.*` | Runtime route/fallback/tool evidence may occur in logs; preserve paths for later targeted extraction |
| OMP-008 | `/Users/jamie/.omp/memories/` | **Absent at this path**; memory material is under `/Users/jamie/.omp/memories/--Users-jamie-.omp--/` in directory listing | Directory listing showed rollout summaries and `memory_summary.md` under the encoded path | Historical | Sol routing decisions and model naming variants appear in rollout-summary filenames/content |
| OMP-009 | `/Users/jamie/.omp/cache/` | Cache DBs and composer/session cache | Includes `legacy-pi-extension-cache.db-wal`, composer `recent-sessions.jsonl` | Historical/current cache | Possible old Pi/session references; not authoritative for model attribution |
| OMP-010 | `/Users/jamie/.omp/config.yml` | **Absent** | 0 | n/a | Actual active config is OMP-011 |
| OMP-011 | `/Users/jamie/.omp/agent/config.yml` | YAML runtime config | 1 file | Current config | `modelRoles` explicitly maps manager/planner/designer/reviewer/synthesizer/security-reviewer/advisor/coordinator to Sol variants; fallback chains are explicit (mostly Luna) |
| OMP-012 | `/Users/jamie/Projects/omp-owned/local/` | Project-local research artifacts, markdown, scripts, generated outputs | Existing Sol corpus artifacts include `gpt56-sol-*` and `gpt-calibration-*` files | Current research corpus | Candidate naming variants and prior extraction notes; this inventory is the requested new artifact |

## Authoritative schemas and fields

### Session JSONL (`OMP-001`)
Observed records include:
- `type: session`: `version`, `id`, `timestamp`, `cwd`, `title`.
- `type: model_change`: `id`, `parentId`, `timestamp`, `model`, `resolvedModelIsFallback` (boolean).
- `type: thinking_level_change`: `parentId`, `thinkingLevel`, `configured`.
- `type: message` / tool execution records: parent linkage, message/tool IDs, role/content, tool name and execution metadata.
- `type: custom` rules markers and `type: custom_message` skill injection records.

Authoritative session ID is the session record `id`; event lineage is `parentId`; requested/resolved model and fallback are on `model_change`. JSONL timestamps are ISO-8601.

### History SQLite (`OMP-002`)
`history(id INTEGER PRIMARY KEY, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, cwd TEXT, session_id TEXT)`. `created_at` is Unix seconds. FTS tables are indexes, not independent authoritative records.

### Benchmark SQLite (`OMP-005`)
`actors` is authoritative for attribution: `actor_id`, `run_id`, `parent_actor_id`, `session_id`, `role`, `requested_model`, `resolved_provider`, `resolved_model`, `thinking_level`, `fallback`, `status`, `terminal_yield`, `started_at`, `ended_at`, `duration_kind`, `duration_ms`, `source_ref`, `outcome`, `semantic_success`, `policy_violations`.

`runs`: `run_id`, `parent_run_id`, source/project paths, task kind, start/end, `run_outcome`, measurement status, tags/stack/cell/trial, verdict outcome. `events`: timestamped event kind/phase/generation and JSON payload. `measurements`: named numeric/text values, units, confidence, source refs (token/cost/effort metrics when present). `tool_calls`: tool name, start/end, duration, outcome, result bytes, async job ID. `artifacts`: path, hash, size, privacy class. `corrections`: correction classification and redo actor. `verdict_receipts`: PASS/ISSUES/BLOCKED/DNF/VOID evidence.

### Usage SQLite (`OMP-003`)
`usage_history`: provider/account/limit/window, used fraction/status/reset timestamp. `usage_cost_history`: provider/account/cost USD/time. `client_usage`: provider/model, requests, input/output/cache token counts and cost (currently empty). `model_perf`: model key, samples, output tokens, generation/TTFT metrics. These are aggregate/supporting stores rather than session lineage.

## Counts and naming variants

- History DB: 4,971 rows in the last 14 days and 6,646 in the last 30 days (all history rows as of query time); Sol/GPT-5.6 textual matches total 479.
- Benchmark actors with Sol/GPT-5.6 in requested or resolved model: 1,127 actors, 1,115 distinct sessions.
- Observed exact variants: `cli-proxy/codex.gpt-5.6-sol.manager`, `cli-proxy/codex.gpt-5.6-sol.reviewer`, `cli-proxy/codex.gpt-5.6-sol.designer`, `cli-proxy/codex.gpt-5.6-sol.synthesizer`, `cli-proxy/codex.gpt-5.6-sol.security-reviewer`, `cli-proxy/codex.gpt-5.6-sol.coordinator`, `cli-proxy/codex.gpt-5.6-sol` (base), `openai-codex/gpt-5.6-sol`, and resolved bare `gpt-5.6-sol`.
- Search variants used: case-insensitive `gpt-5.6`, `gpt56`, `sol`, `5.6-sol`, provider/role suffixes (`.manager`, `.reviewer`, `.designer`, `.synthesizer`, `.coordinator`, `.security-reviewer`), and `codex.gpt` route names.
- Current config also contains Sol role mappings under `modelRoles`; fallback chains generally point to `cli-proxy/codex.gpt-5.6-luna` variants. In the benchmark Sol/GPT-5.6 actor grouping, the displayed aggregate fallback sum is zero; the separate Luna aggregate includes one fallback.

## Verification

Read-only directory enumeration, bounded JSONL sample, SQLite schema inspection, and targeted SQLite counts were performed. No project files, stores, archives, or transcripts were modified or copied. No transcript quality classification was performed.

**Status: PASS**
