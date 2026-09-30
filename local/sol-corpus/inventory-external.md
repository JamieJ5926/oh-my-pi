# External Sol corpus inventory

Inventory date: 2026-08-29. Scope: mounted external volumes visible at `/Volumes`; read-only metadata/member-name inspection only. No files were copied or extracted.

## Mounted volumes and source IDs

| Source ID | Exact root | Access/result | Format/date coverage | Counts and candidate Sol records |
|---|---|---|---|---|
| EXT-BBALL-OMP | `/Volumes/BBALL_GM_DATA/.omp/` | Accessible | OMP store; listing timestamps approximately 1 month ago; `archived_sessions/` contains rollout JSONL dated 2026-07-15 through 2026-07-21 by filename | Directory listing is paginated (first page shows 12 rollout JSONL plus continuation, so exact total requires further pagination). Candidate model records were not found because the displayed path was stale/nonexistent when queried; the actual matching root observed is `/Volumes/BBALL_GM_DATA/offloaded-from-mac/codex/archived_sessions/` (see EXT-BBALL-CODEX). |
| EXT-BBALL-CODEX | `/Volumes/BBALL_GM_DATA/offloaded-from-mac/codex/archived_sessions/` | Accessible | Codex rollout JSONL; filenames observed for 2026-07-15, 2026-07-16, 2026-07-17 | Multiple candidate Sol records. Exact hit: `/Volumes/BBALL_GM_DATA/offloaded-from-mac/codex/archived_sessions/rollout-2026-07-17T15-06-49-019f6e0a-7fea-77d0-8439-a84d23d96635.jsonl` contains `thread_settings_applied` with `model: "gpt-5.6-sol"`, provider `openai` (grep hit at record line 65). Another rollout dated 2026-07-17 contains the same model at line 68. Files are JSONL session records; no credentials copied. |
| EXT-BBALL-PI | `/Volumes/BBALL_GM_DATA/OLD PI/.pi/` | Accessible | Pi artifact store; directory metadata spans approximately 2 months; JSON/Markdown artifacts | Candidate Sol metadata: `/Volumes/BBALL_GM_DATA/OLD PI/.pi/.pi-subagents/artifacts/19e7e155_worker_0_meta.json` has `model: openai-codex/gpt-5.6-sol:high`, attemptedModels same, success true. Additional exact hits in artifact metadata include `9328a046-4ad0-445c-a7c7-e45bae2aa3e3_worker_meta.json`, `a4a6a38f_worker_0_meta.json`, and `b315dfbc_reviewer_0_meta.json`; all observed as `openai-codex/gpt-5.6-sol:high` with successful attempts. Artifact directory is paginated; exact total not asserted. |
| EXT-BBALL-PI-AGENT | `/Volumes/BBALL_GM_DATA/OLD PI/.pi/agent/` | Accessible | Pi agent store; session/control JSON and SQLite orchestration store; approximately 1–2 months old | Observed `sessions/`, `agent-os-terminal/session.json`, `orchestration/orchestration.sqlite`, `stats.db`, and `run-history`/control records. No full transcript copied. Candidate Sol hits are represented by the artifact metadata under EXT-BBALL-PI. |
| EXT-BBALL-PI-CONFIG | `/Volumes/BBALL_GM_DATA/pi-configs/` | Accessible | Pi configuration/backups; listing timestamps approximately 1–2 months | Observed `pi-agent-pre-stabilization-20260716T152209Z.tar.gz`, `fresh-pi-config/`, `agent.archive-20260619T173040/`, and `fresh-pi-runtime/`. Archive member listing was not completed in this pass; archive is recorded as a gzip-compressed tar candidate, not destructively extracted. |
| EXT-BBALL-PI-MANUAL | `/Volumes/BBALL_GM_DATA/pi-manual-test/` | Accessible | Pi manual test root; approximately 1 month old | Observed `.pi-subagents/` and three plan Markdown files; no Sol identifier hit in the bounded inspection. |
| EXT-BBALL-OFFLOADED | `/Volumes/BBALL_GM_DATA/offloaded-from-mac/` | Accessible but very large | Offloaded Mac archive; subtrees metadata from approximately 1 day to 2 months | Observed `codex/`, `omp-untracked-20260827/`, `icloud-archive-20260721/`, `disk-hygiene-20260828/`, `temp copy/`, and other archive roots. Broad recursive glob/grep timed out, so completeness is not claimed. |
| EXT-METALTERM | `/Volumes/Metalterm/` | Accessible | HFS external volume; application bundle only, metadata approximately 2 days | Root contains `Applications/` and `Metalterm.app/Contents/`; no session, OMP, Codex, Pi, JSONL, SQLite, or Sol hit. |
| EXT-TIMEMACHINE | `/Volumes/.timemachine/` | Accessible | APFS Time Machine support volume | Root listing exposed `.fseventsd/` and `offloaded-from-mac/`; no corpus records were read from fsevent logs. Treat as metadata/support area, not a session root. |
| EXT-PI-MOUNT | `/Volumes/.pi/` | Accessible | Hidden Pi mount; listing metadata approximately 2 months | Contains `agent/`, `agent.archive-20260619T173040/`, `fresh-pi-config/`, `fresh-pi-runtime/`, `skills/`, `todos/`, `pi-acp/`, and `plugins/`. This is a second visible Pi copy and should be searched by the Pi inventory lane; no full transcript copied here. |

## Identifier and schema observations

Search variants used in bounded searches: `GPT-5.6`, `GPT_5.6`, `GPT.5.6`, `gpt-5.6`, `gpt_5.6`, `gpt.5.6`, `Sol`, provider/role forms including `openai-codex/gpt-5.6-sol:high` and `model_provider`/`model_provider_id` fields.

Observed Codex JSONL schema fields: top-level `timestamp`, `type`, `payload`; `session_meta.payload` includes session id, timestamp, originator, CLI version, source, and `model_provider`; `thread_settings_applied.thread_settings` includes `model`, `model_provider_id`, service tier, reasoning settings, and permissions.

Observed Pi artifact schema fields: JSON metadata includes `model`, `attemptedModels`, `modelAttempts[]`, `success`, `exitCode`, and usage. This is the strongest stable attribution format for Pi records.

## Archive/container member inspection

- `/Volumes/BBALL_GM_DATA/pi-configs/pi-agent-pre-stabilization-20260716T152209Z.tar.gz` is present and identified by filename as gzip-compressed tar; member names were not extracted or copied. 
- Broad archive globbing over `/Volumes/BBALL_GM_DATA/` timed out before returning a complete set; this is an incomplete scan, not proof of absence.
- No corrupt archive was positively identified. No destructive extraction was attempted.

## Inaccessible, incomplete, or read-stability notes

- `/Volumes/BBALL_GM_DATA/.omp/archived_sessions` returned `Path not found`; the accessible Codex archive is under `/Volumes/BBALL_GM_DATA/offloaded-from-mac/codex/archived_sessions/`.
- Recursive glob/grep over the complete BBALL tree timed out due to tree size. Results above are bounded and preserve exact paths for all observed hits.
- Directory listings are paginated by the reader; where continuation was shown, exact file totals are intentionally not invented. File counts therefore mean explicitly observed entries, not complete-tree totals.
- `/Volumes/Metalterm` is mounted read-only; all other listed external roots were inspected read-only. No project files were edited.
