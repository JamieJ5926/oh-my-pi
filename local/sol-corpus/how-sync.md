# Existing `scripts/session-stats/sync.py`

## Ownership and entry points

- `scripts/session-stats/README.md:11-14,27-35` defines this directory as the owner of ad-hoc session-corpus parsing and the mutable SQLite flow. `sync.py` walks `~/.omp/agent/sessions/` and populates `ss_*` tables; `analyze.py` consumes them.
- `sync.py:21-24` documents the executable CLI. `main()` at `:1136-1234` accepts `--workers` (default `min(16, cpu_count*2)`), `--limit` (newest N, 0 means all), `--full`, and `--root`; it has no manifest, cutoff, source-family, append-only corpus, or frozen snapshot arguments. It always opens the configured `DB_PATH` (`:52-55`) rather than a CLI-selected output.

## Source discovery and incremental state

- Constants `SESSIONS_ROOT`, `DB_PATH`, `TOKENIZER_NAME`, `SCHEMA_VERSION`, and `EDIT_PARSER_VERSION` are at `sync.py:52-59`.
- `discover_sessions(root, limit)` (`:1098-1106`) returns only regular `*.jsonl` files under one root via `Path.rglob`; sorts by filesystem mtime descending, then truncates to `limit`. Missing roots return `[]`. It does not retain a manifest, hashes, archive members, source IDs, discovery errors, or unavailable-vs-absent status.
- `existing_state()` (`:945-954`) reads one mutable state row per path from `ss_sessions`: `(mtime,size,byte_offset,line_count,parser_version)`.
- `decide_action()` (`:1108-1134`) skips when size is unchanged and mtime has not advanced; full-rebuilds on missing state, `--full`, stale parser version, shrink below prior offset, or same-size newer mtime; otherwise resumes at prior byte offset and sequence. This is path/mtime/size based, not content-addressed. A file changed in-place without detectable mtime/size change is indistinguishable from unchanged. Rebuild deletes all derived rows for that path; no append-only history.

## JSONL parsing

- `parse_file(path, starting_offset, starting_seq, full_rebuild)` (`:657-742`) stats the path, derives folder/subagent metadata from pathname through `session_meta_from_path()` (`:613-628`), seeks to the byte offset, iterates binary lines, increments sequence for every physical line (including blank and malformed lines), and ignores malformed JSON (`JSONDecodeError`) after advancing sequence. It recognizes top-level `session` only when `seq == 0`, and top-level `message` records (`:695-728`). Timestamp parsing is `parse_iso_ms()` (`:589-600`), invalid/missing timestamps become `0`.
- Session metadata retained: UUID, version, title, cwd, started timestamp; plus folder, subagent flag, parent path, label (`:667-686`). No native event/session provenance beyond path and entry ID.
- Assistant content is handled by `_ingest_assistant()` (`:749-823`): `toolCall` blocks become tool-call rows with raw/canonical-ish argument JSON, model, provider, timestamp; `thinking` and `text` blocks are joined into assistant message blobs. User content becomes one joined text row via `_ingest_user()` (`:920-931`). Tool results become rows via `_ingest_tool_result()` (`:900-919`).
- Token counts are estimated with tiktoken `o200k_base`: `count_tokens()`/`batch_count_tokens()` (`:200-218`) and one batched pass at end of `parse_file()` (`:733-742`). The parser does not read assistant `usage` or `cost` fields, route-change events, fallback indicators, stop reasons, duration/TTFT, or completion/request IDs. `README.md:77-80` explicitly distinguishes `audit.ts`, which reads real per-request usage, from this sync's retokenization.
- Existing edit-specific parsing is an extension seam: `_ingest_edit_call()` (`:824-899`) parses hashline/legacy sections and precomputes detector values; `_ingest_tool_result()` pairs edit result success/warnings. These fields are analysis-specific and not Sol-study outcome evidence.

## Schema and writes

- `SCHEMA_SQL` (`sync.py:61-183`) creates `ss_sessions`, `ss_tool_calls`, `ss_tool_results`, `ss_assistant_msgs`, `ss_user_msgs`, `ss_edit_calls`, and `ss_edit_sections`, with indexes on tool/time and session/sequence. Tables are not `STRICT`; there are no foreign keys, source-object/version tables, raw-record table, immutable triggers, study/snapshot tables, or canonical model alias table.
- `open_db()` (`:933-943`) creates parent directory, opens `DB_PATH` autocommit connection, enables WAL, `synchronous=NORMAL`, memory temp store and 256 MiB mmap, executes schema, then `_migrate()` (`:185-198`) performs best-effort additive migration of `ss_sessions.parser_version`.
- `write_records()` (`:956-1096`) uses `BEGIN IMMEDIATE` per file and rolls back on any exception. On full rebuild it deletes all six per-file derived tables, then inserts/updates parsed rows. Most entities use `INSERT OR REPLACE`; edit calls use conflict upserts preserving paired result fields; finally `ss_sessions` is upserted with the final offset/line count/mtime/size and parser versions, then commits. Writer exceptions are printed and processing continues (`:1190-1205`), so CLI can exit success despite a file write failure.
- `main()` parses files in a `ProcessPoolExecutor`, sends records through a bounded queue to one writer thread, and closes after sentinel (`:1181-1229`). Parse exceptions are logged and skipped. The transaction boundary is one mutable per-file transaction, not a corpus ingest run.

## Idempotence invariants and limitations

- Stable unchanged path + `(mtime,size)` yields no write (`decide_action()`), so ordinary reruns are idempotent.
- Incremental appends resume at stored byte offset and sequence; unique keys prevent duplicate rows for the same `(session_file, seq)` or `(session_file, call_id, seq)`.
- Full rebuild removes prior rows for that path before replacement. Parser-version bump forces rebuild only to refresh edit-derived rows.
- Idempotence is not content/source identity based: renames, copies, changed bytes with preserved metadata, duplicate source copies, archive members, and historical snapshots are unsupported. Partial malformed lines are silently skipped and are not represented as parse-error records. Failed writes/parses do not make a durable run receipt.

## Sol-study missing evidence / extension seams

The existing ingestion can provide path/session identity, ordinal, timestamps, role/content, model/provider on assistant/tool rows, and approximate text/tool token counts. Its most direct seams are: (1) add a source-object discovery layer beside `discover_sessions()`; (2) expand the event extraction in `parse_file()` and `_ingest_assistant()`/`_ingest_tool_result()`; (3) replace or parallelize `write_records()` with append-only raw-record persistence; (4) retain current `ss_*` compatibility as a derived view if needed. No design is implied here.

Missing fields required by the workflow (`local/sol-corpus/workflow-plan.md`): source root/object/version and hashes; raw record bytes/canonical JSON and parse errors; native event IDs and duplicate-copy links; authoritative model field and alias evidence; provider plus route/model-change history and fallback; request/completion IDs; native usage input/output/cache read/cache write/total and nominal cost; stop reason, duration, TTFT; work-unit/parent-work-unit identity; role/cohort evidence; terminal status/outcome verification and censoring; project/task identifiers; immutable ingest/run manifests and cutoff/window metadata.

## Candidate writable partitions (implementation handoff)

1. **Discovery/manifest lane:** `discover_sessions()` and adjacent source traversal/manifest code; owns roots, objects, archive resolution, hashes, statuses.
2. **JSONL normalization lane:** `parse_file()` and extraction helpers; owns raw record/event normalization, parse errors, native IDs, usage/model-change/fallback fields.
3. **Append-only storage lane:** `SCHEMA_SQL`, migrations/opening, and corpus writer replacing/augmenting `write_records()`; owns transactions, constraints, immutable triggers, ingest receipts.
4. **Compatibility/derived lane:** existing `ss_*` tables and adapters/views; preserves current analyses while consuming normalized records.
5. **CLI/orchestration lane:** `main()`, action planning, run/cutoff/output arguments, worker and writer orchestration, error accounting.

These partitions are file/symbol-oriented; lanes 2 and 3 both touch `sync.py`, so an integration owner or explicit symbol-level merge is required to avoid shared-file conflicts. Existing `packages/stats/test/sync-serial.test.ts:1-88` tests the separate TypeScript `syncAllSessions` path (serial workers, legacy usage cost, macOS default, explicit worker pool); it does not import or execute Python `scripts/session-stats/sync.py` and therefore provides no direct regression coverage for the Python parser/schema/CLI.
