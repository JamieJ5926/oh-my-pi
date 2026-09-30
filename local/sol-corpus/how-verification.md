# Sol corpus verification map

Scope: reusable tests and fixtures for the append-only corpus, normalized snapshots, and GPT-5.6 Sol attribution described in `local/sol-corpus/workflow-plan.md`. This is a read-only inventory of existing coverage; no corpus implementation or HDD data was changed.

## Existing reusable fixtures and behavioral checks

| Workflow contract | Existing evidence to reuse | What it proves / gap |
|---|---|---|
| Append-only ingest and rerun convergence | `scripts/session-stats/audit.test.ts:42-177` builds a temporary JSONL transcript with deterministic records and real usage; `scripts/session-stats/sync.py:52-143` defines incremental `mtime`, `size`, `byte_offset`, `line_count`, and parser/schema version state. `packages/agent/test/append-only-context.test.ts:153-215` exercises append, copy-return, tail replacement, extend, and clear semantics. | Good synthetic JSONL construction and deterministic assertions. No test currently drives `sync.py` twice and compares canonical corpus rows/hashes; no immutable raw-record trigger fixture. Add a tiny multi-source corpus fixture with duplicate location and changed-content versions, then assert second ingest is byte/hash-identical and adds zero duplicate payload rows. |
| Crash recovery / partial ingest | `packages/agent/test/agent-loop.test.ts:589-810` covers transient stream errors, envelope truncation, JSON parse errors, completed-call-only recovery, and excludes incomplete sibling calls. `packages/agent/test/agent.test.ts:786-900` covers persistence during a stream failure and buffering a provider result. | Strong behavioral patterns for interrupted work and “recover only committed/completed” semantics. No corpus transaction interruption test. Add a fixture that fails after each append phase (root, object, records, copy links), reopens SQLite, and verifies no post-commit classification plus a resumable terminal receipt. |
| Source reconciliation / archives | `packages/utils/test/ar/fixtures.ts:1-31` loads a bundled `ar.tar.gz` once and exposes archive-relative fixture bytes; `packages/utils/test/ar/tar.test.ts:1-103` checks paths, modes, mtimes, member bytes, short reads, PAX/GNU long records, links, and dangling links. `packages/agent/test/compaction-file-ops.test.ts:35-145` distinguishes archive member selectors (`archive.zip:dir/file.ts`) from URL/SQLite colons. | Reuse archive fixture-loading and member-path edge cases for bounded archive discovery and hash/member provenance. Missing source-manifest fixture classes: unavailable root, outside-window root, duplicate archive member, changed archive bytes, parse-partial member, and local-vs-HDD same-content reconciliation. |
| SQLite schema / integrity | `packages/ai/test/auth-broker-wire.test.ts:229-263` uses `bun:sqlite`, temporary DBs, readonly inspection, and verifies unrelated commits do not alter managed generation. `packages/ai/test/auth-storage-block-persistence.test.ts:103-170,291-367` creates/migrates schemas, reopens stores, checks persistence, and forces migration failure to verify rollback. | Reuse temp DB lifecycle, readonly row readers, reopen-after-write, and forced-failure rollback patterns. No STRICT-table, append-only trigger, foreign-key, or `PRAGMA integrity_check` fixture for the proposed corpus schema. |
| Model attribution / provider metadata | `packages/ai/test/auth-gateway-model-list.test.ts:10-63` verifies provider-qualified model listing and bundled `openai-codex/gpt-5.6-sol`. `packages/agent/test/otel.test.ts:162-189,475-503,542-558` verifies provider/model normalization and usage callbacks. `packages/agent/test/agent-loop.test.ts:184-240` uses provider-specific mock models and model changes. `scripts/session-stats/audit.test.ts:88-175` records assistant model and usage fields. | Reuse model/provider fixtures and authoritative usage assertions. Missing attribution fixtures: top-level `model_change` winning over path/title, raw aliases with provider/role/effort suffixes, fallback provider recorded separately, and ambiguous/missing authoritative model fields. |
| Cohort attribution | `packages/agent/test/agent-loop.test.ts:30-38,1600-1608` provides explicit `attribution: "agent"`; `packages/agent/test/agent.test.ts:95-110` and nearby steering tests construct `attribution: "user"` and agent steering. | These are the only directly reusable role-attribution shapes found. Add a normalized event fixture covering Jamie-facing (user + assistant), mixed (user plus child/agent work), agent-only (no Jamie event), and unknown/evidence references; assert precedence and deterministic cohort basis. |
| Fuzzy Jamie locators | `packages/tui/test/fuzzy.test.ts:1-35` covers multi-word matching, abbreviation (`og`), CJK filtering, and negative matches. `packages/agent/test/compaction-file-ops.test.ts:35-145` covers selector stripping without corrupting `db.sqlite:users` or archive members. | Reuse fuzzy matching expectations for human locator search, but corpus locators need a separate fixture class: punctuation/case variants, Jamie-name aliases, session title/path mismatch, ambiguous matches, and no-match behavior. Fuzzy ranking must never become identity/deduplication. |
| Snapshot subset / cutoff rules | `scripts/session-stats/audit.test.ts:5-23` tests relative duration parsing, but not fixed UTC windows. `scripts/session-stats/analyze_search_relevance.py:160-205` and `analyze_selector_reads.py:156-193` demonstrate timestamp-filtered SQL and ordered per-session walks. `packages/agent/test/branch-summarization.test.ts:39-103` constructs deterministic timestamped event chains. | Reuse ordered timestamped event builders and SQL window style. Missing fixture classes: exact cutoff inclusion/exclusion at `2026-08-29T00:00:00Z`, lower bounds for 14/30 days, completion-time (not request-start) membership, censored work units, and 14-day rows being a strict subset of 30-day rows. |
| Audit reuse / classifier cache | `scripts/session-stats/README.md:77-108` documents real per-request usage, digest outputs, and cache key `(session id + digest hash + model + prompt hash)`; `scripts/session-stats/audit.test.ts:88-175` verifies usage, turns, spawn labels, residency, pruned result sizes, and last assistant text. | Reuse digest/usage accounting and cache invalidation assertions as audit evidence. Do not reuse its moving wall-clock window or LLM classifier as the corpus identity predicate. |
| Benchmark metadata ingest | `local/sol-corpus/workflow-plan.md` Find-not-invent record identifies `/Users/jamie/.omp/benchmarks/` as durable metadata owner; `scripts/session-stats/README.md:3-5,77-80` describes session parser and native usage. Existing grep found benchmark tests/DB readers under `packages/ai/test/*gateway*` and auth tests, but no Sol-study benchmark-summary ingest test. | Persist benchmark metadata through its existing owner; add cross-source fixture with request/completion IDs, provider, model, usage, and cost, asserting metadata cross-check does not duplicate transcript evidence. |

## Recommended commands

Targeted existing checks (run from repository root):

```sh
bun test scripts/session-stats/audit.test.ts
bun test packages/utils/test/ar/tar.test.ts
bun test packages/tui/test/fuzzy.test.ts
bun test packages/agent/test/append-only-context.test.ts
bun test packages/agent/test/agent-loop.test.ts
bun test packages/agent/test/agent.test.ts
bun test packages/agent/test/compaction-file-ops.test.ts
bun test packages/agent/test/otel.test.ts
bun test packages/ai/test/auth-broker-wire.test.ts
bun test packages/ai/test/auth-storage-block-persistence.test.ts
bun test packages/ai/test/auth-gateway-model-list.test.ts
```

For the future corpus implementation, the minimum scoped command set should add one new corpus verification test file (or one per ownership lane) and run it with the existing audit/archive/SQLite tests above. Avoid full-suite runs in lane work; the project-wide validation owner runs the final suite once.

## Missing fixture classes (implementation requirements)

1. **Corpus source bundle:** small OMP, Pi, Codex, benchmark JSONL/SQLite inputs plus one tar archive; each record has stable native IDs, timestamps, model/provider, usage, role, and a malformed line.
2. **Version/reconciliation bundle:** same bytes at two paths, changed bytes at one path, archive member duplicate, and parse-partial object; expected object/version/copy-link counts are explicit.
3. **Failure-injection bundle:** deterministic abort points after each append transaction phase and before terminal receipt; expected committed row counts and rerun result are tabulated.
4. **Attribution bundle:** model-change event, assistant completion, fallback completion, alias variants, role suffixes, provider mismatch, and absent/ambiguous model evidence.
5. **Cohort/evidence bundle:** Jamie-facing, mixed, agent-only, unknown, and right-censored work units with evidence references.
6. **Temporal bundle:** events exactly at lower bound, one microsecond before/after, exactly at exclusive cutoff, completion crossing request boundary, and no-terminal-evidence censorship.
7. **Locator bundle:** case/punctuation/spacing variants, fuzzy aliases, collisions, and explicit no-match/ambiguous outcomes.
8. **Snapshot fixture:** generated 14-day and 30-day SQLite copies with canonical hashes, frozen flag, protocol/alias/codebook hashes, and subset assertions.

## Five-lane-safe verification partition

Partition by new test/fixture files, not shared production files. Each lane owns its fixture namespace and test file; a final integration owner alone updates any shared test index or command manifest.

1. **Ingest/convergence lane** — append-only transaction order, IDs, duplicate copy links, rerun convergence, changed source versions. Own `corpus-ingest.test.*` and `fixtures/ingest/*`.
2. **Recovery/SQLite lane** — injected failures, reopen/resume, STRICT constraints, foreign keys, triggers, integrity checks, frozen-copy mechanics. Own `corpus-storage.test.*` and `fixtures/storage/*`.
3. **Reconciliation/archive lane** — bounded roots, archive/member hashes, unavailable/outside-window statuses, local/HDD reconciliation. Own `corpus-sources.test.*` and `fixtures/sources/*`.
4. **Attribution/cohort lane** — alias ledger, model-change precedence, fallback/provider metadata, Jamie-facing/mixed/agent-only evidence. Own `corpus-attribution.test.*` and `fixtures/attribution/*`.
5. **Snapshot/locator lane** — fixed UTC subset rules, censoring, 14-day subset of 30-day, fuzzy Jamie locators, snapshot hash/freeze checks. Own `corpus-snapshot.test.*` and `fixtures/snapshots/*`.

Shared schema constants, helper exports, or command manifests should be changed only by the integration owner after lanes return; otherwise lanes remain conflict-free. Every lane reports its exact test command and resolved model/fallback state.

## Verification status

**PASS** — existing reusable tests and fixtures are mapped with exact paths/symbol regions; commands, missing fixture classes, and a five-lane-safe partition are specified. No existing test proves the new corpus contracts end-to-end; the missing classes above are required before implementation can claim those behaviors.
