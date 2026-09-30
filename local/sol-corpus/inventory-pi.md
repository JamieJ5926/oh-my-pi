# Pi / oh-my-pi session-store inventory

Status: **PASS**  
Scope: read-only inventory and format reverse-engineering; no transcripts copied.

## Source IDs

| Source ID | Original path | Format / schema | Files / records | Date range | Sol candidates |
|---|---|---|---:|---|---|
| PI-MAC-001 | `/Users/jamie/.pi/agent/sessions/` | Pi v3 JSONL. First record is `{type:"session",version:3,id,timestamp,cwd}`; model switches are `{type:"model_change",provider,modelId}`; turns are `message` records with nested role/content, API/provider/model/usage/stopReason/errorMessage; tool calls are nested assistant content and tool-result records. | 47 JSONL files; 1,938 total lines across session trees (includes nested run/artifact JSONL) | 2026-07-31 through 2026-08-28 by filename/session timestamps | 26 files match `gpt-5.6-sol`, `gpt56`, or `sol` (broad content search; some matches are quoted/config text rather than active attribution). Direct active attribution observed in sessions including `/Users/jamie/.pi/agent/sessions/--Users-jamie--/2026-08-22T01-29-16-627Z_01a02716-2053-7c79-9a02-0fea91cc9ee6.jsonl` and `/Users/jamie/.pi/agent/sessions/--Users-jamie-Projects-omp-owned--/2026-08-28T11-53-26-784Z_01a04837-ba00-7322-9813-6a628bdb23e9.jsonl`. |
| PI-MAC-002 | `/Users/jamie/.pi/agent/` | Model/config store: `models-store.json` provider-keyed model arrays, with id/name/api/provider/baseUrl/cost/contextWindow/thinkingLevelMap/compat; `models.json` and dated `.bak` copies; `auth.json` and dated backups; `settings.json`, `trust.json`, `run-history.jsonl`. | 1 live model store, 2 live model/config JSONs, 5 dated model/auth backups, 1 run-history JSONL | Models store metadata includes checked/modified epochs; backups dated 2026-08-06 and 2026-08-12 | `models-store.json` explicitly defines `openai-codex` / `gpt-5.6-sol` (name `GPT-5.6 Sol`, API `openai-codex-responses`). |
| PI-MAC-003 | `/Users/jamie/.pi/agent/extensions/` and `/Users/jamie/.pi/agent/disabled-2026-08-26/` | TypeScript extension source/artifacts; extension state/intercom stores are directory-based. | Present; not session records | Current and archived setup state | Routing extension contains model-resolution/display logic; no standalone Sol transcript store identified. |
| PI-ARCH-001 | `/Users/jamie/Projects/reference/custom-pi-rebuild-20260620/` | Archived project `.pi` directories: prompts/skills/workflow JSON/JSONL-like artifacts and setup documents; no discovered session JSONL in the scoped archive. | 105 `.pi` directories under `/Users/jamie/Projects/reference` overall; 4 JSONL files in selected archive scan | Archive names indicate 2026-06-20 rebuild lineage; files may predate two-month window | No direct Sol session hit in selected archive files; `fresh-pi-build/.pi/workflow/session-map.json` is an index-like artifact. |
| PI-ARCH-002 | `/Users/jamie/Projects/reference/old-pi-setups/full-projects-backup/` | Legacy `.pi` roots containing prompts, skills, git/npm state, todos, run-logs, and fixture/session-like JSONL. | Legacy roots observed for `pi-rust-substrate`, `pi-ui`, `BBALL_GM`, `discord-client`, `agent-os-terminal`, etc.; no destructive extraction | Historical setup copies; dates vary by contained files | No direct active Sol attribution established from the bounded scan; candidate locations are legacy `.pi/run-logs/` and fixture JSONL under `reference/oh-my-pi/packages/coding-agent/test/fixtures/`. |
| PI-HDD-001 | `/Volumes/BBALL_GM_DATA/` | **Not accessible/confirmed in this pass**: bounded glob timed out before producing matches, so absence cannot be inferred. | Unknown | Unknown | Unknown; requires a scoped HDD traversal by subdirectory. |

## Observed attribution and lifecycle fields

- **Active model attribution:** `model_change` records carry `provider` and `modelId`; assistant completion records repeat `api`, `provider`, `model`, `usage`, `stopReason`, and optional `errorMessage`/response IDs.
- **Role attribution:** Pi JSONL does not put a separate durable role field on the session header. Role is represented in each `message.message.role` (`user`, `assistant`, tool-related records), while OMP/Pstack role names can appear in cwd, custom messages, prompts, or surrounding session artifacts.
- **Thinking level:** `thinking_level_change` records carry `thinkingLevel` (e.g. `low`, `high`, `xhigh`, `off`).
- **Usage:** assistant completion records contain input/output/cacheRead/cacheWrite/reasoning/totalTokens and cost subfields. Zero-usage records are present for aborted/error completions.
- **Tool calls:** assistant message content may contain `type:"toolCall"` with tool name/arguments; matching `toolResult` records carry tool output and error flags. Large outputs may be represented as linked/full-output paths in the serialized record.
- **Completion signals:** normal completion is `stopReason:"stop"` or raw stop reason `completed`; failures use `stopReason:"error"` or `"aborted"` plus `errorMessage`; partial/unfinished sessions can end after a user/tool record without a successful assistant completion.
- **Fallback evidence:** a provider/model transition is explicit when a `model_change` follows an error. Example: a 2026-08-26 session records `cli-proxy` + `gpt-5.6-sol` error (`unknown provider`) followed by `openai-codex` + `gpt-5.6-sol`; this is a provider correction, not silent fallback. Routing-info text says fallback is not observable at dispatch and must be treated as unverified when absent.

## Candidate Sol records

Confirmed direct records include:

1. `/Users/jamie/.pi/agent/sessions/--Users-jamie-Projects-omp-owned--/2026-08-28T11-53-26-784Z_01a04837-ba00-7322-9813-6a628bdb23e9.jsonl`: header cwd `/Users/jamie/Projects/omp-owned`; `model_change` provider `openai-codex`, modelId `gpt-5.6-sol`; successful assistant completion with usage and `stopReason:"stop"`.
2. `/Users/jamie/.pi/agent/sessions/--Users-jamie--/2026-08-22T01-29-16-627Z_01a02716-2053-7c79-9a02-0fea91cc9ee6.jsonl`: Sol active initially, later explicit model change to local `qwen-mlx`; subsequent records show local-model abort/error. This is a mixed-model session and must not be counted as Sol-only.
3. `/Users/jamie/.pi/agent/sessions/--Users-jamie--/2026-08-26T23-18-32-198Z_01a0405e-3a06-7fb4-ae57-572482e3e561.jsonl`: initial `cli-proxy/gpt-5.6-sol` error, then explicit `openai-codex/gpt-5.6-sol`; fallback state is observable as an explicit provider transition.
4. `/Users/jamie/.pi/agent/sessions/--Users-jamie--/2026-08-11T12-31-52-903Z_019ff0ce-ce47-7caf-9f6e-c8dc96abf8dd.jsonl`: direct `openai-codex/gpt-5.6-sol` attribution.

Broad-hit count is intentionally conservative: it counts files containing variants, not unique active Sol turns. Full per-record extraction is deferred per contract.

## Coverage limits

The MacBook Pi roots and local archived/reference roots were enumerated read-only. The mounted HDD root scan timed out and therefore remains unresolved rather than being reported empty. No credentials or unrelated private content were copied into this inventory.
