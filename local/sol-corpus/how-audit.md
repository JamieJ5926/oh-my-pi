# Audit subsystem reuse notes

## Ownership and entry points

`scripts/session-stats/audit.ts` is the current owner of direct OMP session JSONL parsing and token-usage analysis. `scripts/session-stats/README.md:75-109` documents it as a standalone Bun command that reads `~/.omp/agent/sessions/` directly, without `sync.py` or tiktoken. The CLI entry is `main()` at `audit.ts:1312`; it parses options with `parseCli()` and runs discovery, scanning, reporting, optional classification, JSON export, and aggregate classification. `parseCli()` is intentionally private. The test-visible helpers are `parseSince`, `normalizeReadPath`, and `scanFile`.

The clean integration seam for the Sol workflow is a shared parser module under `scripts/session-stats/`, with `audit.ts` retaining its existing CLI/report/classifier orchestration. The new study command should consume normalized events or scan records from that module, not parse the JSONL a second time. Do not reuse the moving-window discovery as the study's source manifest: `discoverGroups()` uses `Date.now() - opts.since`, directory mtimes, OMP-specific folder layout, and silently skips unreadable entries.

## Usage parsing and accounting

`scanFile(filePath)` at `audit.ts:310-522` reads the whole JSONL with `Bun.file(filePath).text()`, splits on newlines, ignores malformed lines as a torn writer tail, and ignores unknown record types. It recognizes:

- `type: "session"`: title and initial timestamp.
- `type: "compaction"`: increments `compactions`.
- `type: "message", message.role: "user"`: starts a `TurnInfo`; text is flattened by `contentText()` and clipped to 400 characters.
- `role: "assistant"`: counts one request, reads `message.usage.input/output/cacheRead/cacheWrite/cost.total`, records model and error stop reason, and processes text/tool-call blocks.
- `role: "toolResult"`: joins the matching pending tool call by `toolCallId`, estimates result tokens, updates tool/read/spawn accounting, and records errors.

`UsageTotals` (`audit.ts:146-170`) is the core additive model: input, output, cacheRead, cacheWrite, cost, and request count. `emptyUsage()`, `addUsage()`, and `billedTokens()` are behavior-neutral candidates for a shared usage module. Usage values are taken from recorded assistant-message fields, with `|| 0` fallback. The implementation does not infer usage from text and does not preserve provider, route, fallback, or request IDs. For the Sol study, native completion/request metadata must be captured before adapting into this shape; adding fields to the shared normalized event model is safer than treating `FileScan` as authoritative study evidence.

The context peak is the maximum of `input + cacheRead + cacheWrite` for one assistant request (`scanFile:409`). Result token estimates use `estTokens(text)` (`audit.ts:237-239`, `ceil(chars / 4)`). A pruned result placeholder matching `TRUNCATED_RESULT_RE` (`audit.ts:243`) overrides the estimate with the embedded true token count. This is a useful reusable rule, but the study must label non-native estimates separately from recorded usage.

Residency is a second-pass calculation over `resultLog` and `readLog` (`audit.ts:508-519`): each result's estimated tokens are multiplied by `requestCount - requestIndex`. This depends on assistant-message order as request order, not timestamps. It is suitable for descriptive audit metrics, not a completion-window token attribution without explicit event timestamps.

## Path and tool assumptions

`normalizeReadPath()` (`audit.ts:247-254`) repeatedly strips trailing `:raw`, `:conflicts`, or numeric/range selectors while leaving `artifact://` and `agent://` prefixes intact. Existing tests at `audit.test.ts:20-42` cover ranges, raw selectors, internal URLs, and selector-free paths. This function can move unchanged to a shared event utility, with its current tests moved or retained as contract tests.

`contentText()` (`audit.ts:256-266`) only extracts string content or array items whose `type` is `text`; structured tool output is not serialized. `clip()` (`audit.ts:268-271`) collapses whitespace and adds a Unicode ellipsis after the character limit. `argSummary()` (`audit.ts:274-301`) is report-only formatting and should stay with the audit digest/report code. It has explicit assumptions for `read/write/edit`, `bash`, `search`, `find`, and `task`, then JSON-stringifies unknown arguments.

Tool-call state is local to one scan. `PendingCall` (`audit.ts:304-308`) maps call IDs to name, args, and assistant request index. `ToolAgg`, `SpawnCall`, `TurnInfo`, `TopResult`, and `FileScan` (`audit.ts:175-236`) are audit-specific aggregate types. A shared parser should expose raw/normalized events and recorded usage, then have an audit adapter construct these aggregates. Moving `FileScan` wholesale would couple the Sol snapshot builder to report-only fields such as `lastAssistantText`, `topResults`, and `lastToolName`.

Task linkage assumes child filenames. `scanGroup()` (`audit.ts:601-618`) scans a main file plus recursively discovered child JSONLs, while `baseLabel()` (`audit.ts:700-701`) strips a trailing `-N` retry suffix. `buildDigest()` links child stems to main `task` labels by this heuristic. It is not a stable work-unit identity and must not be used as the Sol study's canonical parent/child key without retaining evidence and conflict status.

## Digest construction

`buildDigest(group)` (`audit.ts:712-822`) is a deterministic, bounded classifier input. It uses only the main scan for main-context sections, merges child costs through `SessionGroup`, emits title/folder/models/wall time/turn flow/tool traffic/repeated reads/largest results/edits/task spawns/unlinked children, and truncates the final string at 26,000 characters. `mergeToolAggs()` (`audit.ts:680-697`) exists for aggregate tool totals but is used by digest/report code, not as a general event model.

Digest assumptions that matter for reuse:

- Main versus child context is decided by the filesystem group layout, not event metadata.
- User turns are segmented by encountered user messages; assistant requests attach to the latest turn.
- Model counts come from assistant `message.model` only.
- `wall time` uses `lastTs - firstTs`; session header timestamps may seed `firstTs`.
- Turn and tool token figures mix real API usage with `~` character estimates.
- Only the first 40 turns, 14 tools, 8 repeated reads, 8 large results, and 24 spawn calls are emitted.

The digest builder is reusable only as an audit-classifier presentation format. Extracting it should accept a stable `SessionGroup`-like view and keep study snapshot fields out of the digest. If the Sol classifier needs a digest, version and hash the format explicitly rather than relying on the current implicit `Bun.hash` key.

## Classifier and cache

`openClassifier()` (`audit.ts:1000-1015`) resolves `<provider>/<model-id>` through the bundled catalog and OMP SQLite auth storage (`getAgentDbPath`, `SqliteAuthCredentialStore`, `AuthStorage`). `completeStructured()` (`audit.ts:1017-1062`) calls `completeSimple()` with the imported `audit-prompt.md`, a `respond` tool schema, forced tool choice, disabled reasoning, and up to three retries. It returns structured tool arguments plus `usageOf()` (`audit.ts:1065-1075`) conversion into `UsageTotals`.

The response contract is `SESSION_SCHEMA` (`audit.ts:852-914`) and `AGGREGATE_SCHEMA` (`audit.ts:922-944`), checked only by lightweight `validateSessionVerdict()` and `validateAggregate()` (`audit.ts:946-960`). `normalizeVerdict()` (`audit.ts:969-992`) clamps/defaults renderer fields and sorts waste by dollars, then tokens. These are classifier-specific and should not enter the corpus parser module.

The cache is `~/.omp/stats-audit-cache.json`. `VerdictCacheEntry`, `VerdictCache`, `loadVerdictCache()`, and `saveVerdictCache()` are at `audit.ts:1088-1115`; saving keeps the newest 500 entries by timestamp. `verdictCacheKey()` (`audit.ts:1120-1121`) hashes group ID, digest, model, and imported system prompt with `Bun.hash`. Thus transcript/digest/prompt/model changes invalidate entries, but the key is not cryptographic and does not include a parser/protocol version, source object hash, provider route metadata, or schema hash. Reuse the content-addressed idea for Sol classification only after adding explicit protocol/parser/prompt/classifier identity and a durable artifact location. Do not share this mutable cache file with frozen snapshot outputs.

## Test coverage and gaps

`audit.test.ts:7-18` covers `parseSince()` for h/d/w/mo and invalid suffixes. `audit.test.ts:20-42` covers path normalization. The synthetic `scanFile` contract test at `audit.test.ts:87-177` verifies recorded usage sums, context peak, two user turns, task spawn labels and pruned result recovery, repeated-read grouping, residency, final assistant text, and session title. It does not cover malformed JSON tails, missing usage fields, assistant errors, edit errors, compaction records, unknown content blocks, missing tool results, duplicate call IDs, child-group discovery, digest truncation/linking, classifier retries/validation, cache corruption/pruning, or model/auth failures.

The existing test is strong evidence for current scan behavior but is not coverage for the study protocol. Add targeted tests in the shared parser seam for event ordering, half-open timestamp selection, model-change/route evidence, source copies, and right-censoring. Preserve the current audit test unchanged or move it with the same assertions to prevent behavior drift.

## Recommended module seams

1. `session-events.ts`: parse one JSONL object into typed normalized events, retaining raw record identity, ordinal, timestamps, roles, model/provider fields, tool calls/results, and parse errors. This is the only layer that should know OMP JSONL record shapes.
2. `session-usage.ts`: `UsageTotals`, `emptyUsage`, `addUsage`, `billedTokens`, recorded usage extraction, truncated-result token recovery, and path normalization. Keep estimated versus recorded quantities explicit.
3. `audit-scan.ts`: adapt normalized events into `FileScan`, including residency, read counts, spawn aggregates, and report-only last/top fields. `scanFile` can remain the compatibility export.
4. `audit-digest.ts`: `buildDigest`, formatting helpers, child-label linking, and classifier presentation limits. Version the digest format for study use.
5. `audit-classifier.ts`: schemas, validation, normalization, auth/model opening, structured completion, and cache operations. Parameterize cache path and identity fields for testability; keep the existing default path and behavior in the CLI adapter.
6. `audit.ts`: CLI parsing, moving-window discovery, group orchestration, console/JSON reports, and main program.

The Sol implementation manager can partition five writer lanes without shared-file conflicts by assigning one lane each to event parsing, usage/scanning adapter, digest/classifier extraction, corpus/snapshot integration, and tests. The integration owner should resolve shared exports and imports after the lanes return. No behavior change is required for the existing audit CLI; the key rule is to make the shared parser additive and preserve `scanFile`, `normalizeReadPath`, and current test contracts.

## Verification

Read-only inspection completed for `audit.ts`, `audit.test.ts`, `audit-prompt.md`, `scripts/session-stats/README.md`, and `local/sol-corpus/workflow-plan.md`. No repository files or corpus data were modified other than this requested artifact. No builds, formatters, linters, or tests were run, per assignment constraints.
