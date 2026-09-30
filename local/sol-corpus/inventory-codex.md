# Codex session / rollout inventory

Status: PASS (read-only inventory; no transcripts copied).

## Sources

| Source ID | Root / path | Format | Observed date range | File count / scale | Sol candidates |
|---|---|---|---|---|---|
| COD-MAC-ROLL | `/Users/jamie/.codex/sessions/2026/` | newline-delimited JSON (`rollout-YYYY-MM-DD...jsonl`) | 2026-06-20 through 2026-08-28 (directory months 06, 07, 08) | At least 200 visible in glob output; July alone exceeds 200 and is paginated; exact total not safely inferred from capped listing | Exact `gpt-5.6-sol` observed in July 16 rollout records; variant search also targeted `GPT-5.6`, `gpt-5.6`, `5.6-sol`, `5.6_luna`, `Sol` |
| COD-MAC-DB-HIST | `/Users/jamie/.codex/thread_history_1.sqlite` | SQLite | live/current store; rows carry epoch-like timestamps | `thread_items` 173 rows shown; `thread_turns` 20 rows shown | Model attribution is projected in JSON item payloads; schema exposes item type, ordinal, timestamps, offsets |
| COD-MAC-DB-LOG | `/Users/jamie/.codex/logs_2.sqlite` | SQLite | live/current logs | `logs` 50,000+ rows | Operational log store; schema fields include timestamp, nanosecond timestamp, level, target, feedback, module, file, line, thread/process metadata |
| COD-MAC-STATE | `/Users/jamie/.codex/.codex-global-state.json` and `.bak` | JSON state | current/rolling | 2 state files | Thread-client and workspace mappings; no full transcript; may retain model/session UI state |
| COD-HDD-OMP | `/Volumes/BBALL_GM_DATA/.omp/` | mixed SQLite/JSON/cache/log/archive tree | archive/current (filesystem dates not exhaustively enumerated) | directories include `logs`, `agent`, `profiles`, `webcache`, `plugins`, `cache`, `remote-host`, `puppeteer`, `run`; files include `stats.db`, `autoqa.db`, `gpu_cache.json` | Candidate archive surface; no full recursive grep completed because HDD scans timed out |
| COD-HDD-ARCH | `/Volumes/BBALL_GM_DATA/` | mixed backup/archive tree | historical/unknown | top-level includes `.omp-backup-20260725-142232`, `OLD STUFF JUST INCASE`, `OLD DRIVE`, `OLD PI`, `Jamie-Backups`, and `hermes-mac-backup.zip` | Candidate old-home/setup stores; recursive enumeration intentionally bounded/read-only |

## Rollout schema notes

A representative rollout begins with a `session_meta` object, then one JSON object per line. `session_meta.payload` includes `session_id`, `id`, optional `parent_thread_id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `thread_source`, `model_provider`, and `base_instructions`. Subsequent records include `event_msg` (`task_started`, `task_complete`, `thread_settings_applied`, token counts, etc.) and `response_item` messages/reasoning/tool calls. `turn_context` records include `model`, `reasoning_effort`, permission/profile data, and workspace roots. `thread_settings_applied.thread_settings` is the strongest direct route evidence: observed record contains `model: "gpt-5.6-sol"`, `model_provider_id: "openai"`, `service_tier: "priority"`, `reasoning_effort: "medium"`, and personality/collaboration settings.

A concrete observed hit is `/Users/jamie/.codex/sessions/2026/07/16/rollout-2026-07-16T23-48-33-019f6ac1-cbe8-7e11-b092-d169e0d8197a.jsonl` (session ID `019f6ac1-cbe8-7e11-b092-d169e0d8197a`). Lines 165 and 183/196 show `thread_settings_applied` with exact `gpt-5.6-sol`; provider is `openai`, service tier `priority`, reasoning effort `medium`. The same file records `cli_version: 0.144.0-alpha.4`, originator `Codex Desktop`, source `vscode`, and cwd `/Users/jamie/Documents/codex-rebuild`.

Another observed route record in `/Users/jamie/.codex/sessions/2026/07/17/rollout-2026-07-17T11-19-48-019f6d3a-a7e0-7d81-9030-fd441f193aa4.jsonl` has `turn_context.model: "gpt-5.6-sol"` and workspace `/Users/jamie`; it demonstrates direct attribution in context even when settings are not repeated on every turn.

## Base Codex vs OMP-wrapped distinction

Base Codex indicators observed: `originator: "Codex Desktop"`, `source: "vscode"`, `thread_source: "user"`, `model_provider: "openai"`, standard Codex `base_instructions` beginning “You are Codex, an agent based on GPT-5.” OMP-wrapped/subagent indicators are separate records whose `source` is an object such as `{ "subagent": { "other": "guardian" } }`, `thread_source: "subagent"`, and model such as `codex-auto-review`; these can share the same rollout corpus but should not be classified as direct Sol user sessions without a settings/context record. OMP wrapping may also be inferred from developer messages containing OMP role/agent instructions, but that content was not copied into this inventory.

## Search / caveats

- Exact and variant identifier probes were run against MacBook rollouts and bounded HDD archive roots. Exact `gpt-5.6-sol` was confirmed in MacBook Codex records.
- `sessions.json` was not found in the visible `.codex` tree; current Codex persists primary history as dated rollout JSONL plus SQLite projections/state.
- HDD recursive glob/grep scans timed out due to archive size; therefore HDD source IDs identify accessible candidate roots, not an exhaustive claim of zero/positive Sol records. No destructive extraction or archive copying was performed.
- Timestamps in SQLite are epoch-like numeric values; rollout filenames and ISO `timestamp` fields are the reliable date-range indicators. Encrypted reasoning payloads are present and were not decoded or copied.
- No credentials or unrelated private transcript content is included.
