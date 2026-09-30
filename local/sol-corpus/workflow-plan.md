# GPT-5.6 Sol corpus study workflow

Status: Phase B study plan

Rigor level: **R4, auditable observational study**. The workflow freezes its protocol, source inventory, append-only evidence, normalized snapshots, labels, and decisions. It supports a causal model-quality claim only for controlled Tier A pairs. Unmatched history supports descriptive conclusions, not a claim that one model caused a better result.

Human checkpoint: one blinded review after the two-week pilot. The reviewer locks the model-alias ledger, cohort assignments for sampled edge cases, the task codebook, and calibration and holdout labels. No later judgment changes the locked study version. A failed holdout starts a new version rather than moving a threshold.

## Fixed study question and windows

The study answers:

1. Which task classes produce useful GPT-5.6 Sol work?
2. Which task classes consume GPT-5.6 Sol tokens without a usable contribution?
3. How do success, failure, and wasted-token rates differ between Jamie-facing, mixed, and agent-only work?

Provider and wallet remain recorded because they affect cost and fallback. They do not define Sol. The primary identity is canonical model `gpt-5.6-sol` in an authoritative routing or completion field.

Use one UTC cutoff for both snapshots:

- Cutoff: `2026-08-29T00:00:00Z`, exclusive.
- Two weeks: `[2026-08-15T00:00:00Z, 2026-08-29T00:00:00Z)`.
- One month: rolling 30 days, `[2026-07-30T00:00:00Z, 2026-08-29T00:00:00Z)`.

The two-week result is provisional. Run it first, pass every gate, then run the month. The month is final for this study version. Do not substitute a calendar month or compute either lower bound from wall time.

A request belongs to a snapshot when its completion timestamp falls inside the half-open interval. A work unit belongs when it has at least one included Sol request. A work unit without terminal evidence before the cutoff is right-censored. Count its tokens under `unresolved`, but exclude it from success, failure, useful, wasted, and comparison rates.

## Storage boundary and non-destructive ingest

The HDD corpus is canonical:

```text
/Volumes/BBALL_GM_DATA/sol-corpus/
  corpus.sqlite                    append-only discovered records and provenance
  manifests/                       immutable source and ingest manifests
  snapshots/                       frozen 14-day and 30-day analysis databases
  artifacts/                       codebooks, samples, TSVs, reports, hashes
```

Raw MacBook and HDD source files stay in place. Do not move, rename, delete, or rewrite them. The ingest reads each source object, records provenance and hashes, and appends every discovered record to `corpus.sqlite` before any Sol, time, role, cohort, or task filter runs. Analysis reads only the consolidated corpus. A changed source file becomes a new `source_object_version`; it never mutates an earlier observation.

A compact project index MAY live at `local/sol-corpus/corpus-index.sqlite`. It contains only IDs, paths, timestamps, hashes, counts, and canonical HDD row references. It is rebuildable and never authoritative. The workflow plan and small decision artifacts may stay in the project; the large corpus and frozen databases stay on the HDD.

## Find-not-invent record

Class: Pattern, Code reuse, and Data.

Verdict: **ADOPT-EXISTING**. `scripts/session-stats/` owns session-corpus parsing and analysis. The implementation adds a `sol-study` command inside that owner and moves shared event parsing out of `audit.ts`; it does not create a second parser. `/Users/jamie/.omp/benchmarks/` remains the owner of durable metadata summaries.

Search record:

- `glob "scripts/**/*;local/sol-corpus/**/*;**/*corpus*;**/*benchmark*.{py,ts,js,sql,md}"` found `scripts/session-stats/`, prior Sol inventories, and no existing workflow at the target.
- `scripts/session-stats/README.md:3-5` identifies the mutable SQLite session flow. Its record granularity is at `:46-50`; reported per-request usage handling is at `:77-80`.
- `scripts/session-stats/sync.py:52-55` fixes the current source and database defaults. Its CLI accepts one `--root` but no manifest, cutoff, append-only corpus, or frozen output at `sync.py:1136-1155`. Its parser handles session and message records at `sync.py:710-728`, but does not persist route changes, fallback, or native request usage.
- `local/gpt56-sol-corpus-inventory.md:4-10` establishes that OMP route attribution comes from top-level `model_change` records and pathname is not the deduplication key. The exact-manager scan is evidence for one variant, not a complete Sol predicate.
- `/Users/jamie/.omp/benchmarks/README.md:3` states the benchmark database stores metadata rather than prompt or message bodies. Existing ingest and verdict contracts are at `:16-25`; cost semantics are at `:33`.
- `/Users/jamie/.omp/benchmarks/omp-benchmark.ts:20` lists the live commands and has no study-summary ingest command.
- SQLite `STRICT` tables provide type checks and extend `PRAGMA integrity_check`: <https://www.sqlite.org/stricttables.html>.
- `VACUUM INTO` produces a transactionally consistent SQLite copy: <https://www.sqlite.org/lang_vacuum.html#vacuuminto>.
- Cohen's kappa measures agreement beyond chance: <https://scikit-learn.org/stable/modules/generated/sklearn.metrics.cohen_kappa_score.html>.
- SciPy documents seeded paired BCa bootstrap intervals: <https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html>.

Existing components are incomplete but remain the owners:

- Extend `sync.py` ownership rather than adopt its mutable file-oriented schema unchanged.
- Reuse `audit.ts` usage parsing, digest construction, and content-addressed classifier cache. Its current moving OMP-only window is not a source manifest or frozen study.
- Use `omp-benchmark.ts` for metadata persistence only. Transcript-derived evidence belongs in the HDD corpus.

## Source manifest

Phase 1 must account for every required root. `unavailable` is a recorded result with exact error and time. It is not `absent`. A MacBook-and-HDD conclusion requires every required source to be `complete` or proven outside the window.

| Source ID | Kind | Root or object | Use |
| --- | --- | --- | --- |
| `mac-omp-jsonl` | OMP JSONL | `/Users/jamie/.omp/agent/sessions/**/*.jsonl` | Primary OMP events and usage. |
| `mac-pi-jsonl` | Pi JSONL | `/Users/jamie/.pi/agent/sessions/**/*.jsonl` | Primary Pi events and usage. |
| `mac-codex-rollout` | Codex JSONL | `/Users/jamie/.codex/sessions/2026/**/*.jsonl` | Primary Codex turns and completions. |
| `mac-codex-thread-db` | SQLite | `/Users/jamie/.codex/thread_history_1.sqlite` | Coverage and byte-offset cross-check. Do not double-ingest rollout content. |
| `mac-omp-benchmark` | SQLite | `/Users/jamie/.omp/benchmarks/omp-benchmarks.sqlite` | Attribution and usage cross-check, then metadata persistence. |
| `hdd-omp-current` | OMP tree | `/Volumes/BBALL_GM_DATA/.omp` | Historical OMP copies. |
| `hdd-omp-backup` | OMP tree | `/Volumes/BBALL_GM_DATA/.omp-backup-20260725-142232` | Historical OMP copies. |
| `hdd-codex-offload` | Codex tree | `/Volumes/BBALL_GM_DATA/offloaded-from-mac/codex/archived_sessions` | Archived rollouts. |
| `hdd-old-pi` | Pi tree | `/Volumes/BBALL_GM_DATA/OLD PI/.pi` | Historical Pi data. |
| `hdd-pi-configs` | Pi tree | `/Volumes/BBALL_GM_DATA/pi-configs` | Candidate Pi data and model metadata. |
| `hdd-pi-manual` | Pi tree | `/Volumes/BBALL_GM_DATA/pi-manual-test` | Candidate manual-test sessions. |
| `volume-pi-hidden` | Pi tree | `/Volumes/.pi` | Mounted Pi data and archives. |
| `hdd-pi-archive` | tar archive | `pi-agent-pre-stabilization-20260716T152209Z.tar.gz`, resolved by bounded discovery | Archive members are source objects. |

Root manifest fields:

```text
source_id, source_kind, host_id, storage_id, volume_uuid, root_uri,
format_version, discovery_spec, required, observed_at_utc, status,
status_detail, object_count, byte_count, root_manifest_sha256
```

Object fields:

```text
source_id, relative_path, archive_path, archive_member, size_bytes,
mtime_ns, inode_if_local, sha256, record_count, first_event_at,
last_event_at, parse_status, parse_error_count, candidate_model_count
```

Sort roots by `source_id` and objects by UTF-8 relative path before hashing. Hash archive bytes and member bytes separately. Use bounded traversal per listed root. A broad scan timeout is a manifest `unavailable` observation until the bounded scan succeeds.

## Canonical append-only dataset

`/Volumes/BBALL_GM_DATA/sol-corpus/corpus.sqlite` stores all discovered records before selection. Use SQLite 3.37 or later, `PRAGMA foreign_keys=ON`, and `STRICT` tables. IDs come from native IDs or SHA-256, never wall time or row order.

```sql
CREATE TABLE corpus_meta (
  corpus_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at_utc TEXT NOT NULL,
  append_only INTEGER NOT NULL CHECK(append_only = 1)
) STRICT;

CREATE TABLE ingest_run (
  ingest_id TEXT PRIMARY KEY,
  protocol_sha256 TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  tool_version TEXT NOT NULL,
  manifest_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
  error_text TEXT
) STRICT;

CREATE TABLE source_root_observation (
  observation_id TEXT PRIMARY KEY,
  ingest_id TEXT NOT NULL REFERENCES ingest_run(ingest_id),
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  host_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  volume_uuid TEXT,
  root_uri TEXT NOT NULL,
  discovery_spec_json TEXT NOT NULL CHECK(json_valid(discovery_spec_json)),
  observed_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','outside_window','unavailable','failed')),
  status_detail TEXT,
  root_manifest_sha256 TEXT NOT NULL,
  UNIQUE(ingest_id, source_id)
) STRICT;

CREATE TABLE source_object_version (
  object_version_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES source_root_observation(observation_id),
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  archive_member TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  mtime_ns INTEGER,
  inode_if_local INTEGER,
  content_sha256 TEXT NOT NULL,
  record_count INTEGER CHECK(record_count >= 0),
  first_event_at_utc TEXT,
  last_event_at_utc TEXT,
  parse_status TEXT NOT NULL CHECK(parse_status IN ('ok','partial','failed','not_applicable')),
  parse_error_count INTEGER NOT NULL CHECK(parse_error_count >= 0),
  UNIQUE(source_id, relative_path, archive_member, content_sha256)
) STRICT;

CREATE TABLE raw_record (
  raw_record_id TEXT PRIMARY KEY,
  object_version_id TEXT NOT NULL REFERENCES source_object_version(object_version_id),
  source_family TEXT NOT NULL CHECK(source_family IN ('omp','pi','codex','benchmark','unknown')),
  native_session_id TEXT,
  native_record_id TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  record_at_utc TEXT,
  record_type TEXT,
  speaker_role_raw TEXT,
  raw_bytes_sha256 TEXT NOT NULL,
  canonical_json_sha256 TEXT,
  payload_json TEXT,
  parse_error_text TEXT,
  CHECK(payload_json IS NULL OR json_valid(payload_json))
) STRICT;

CREATE TABLE raw_record_source_copy (
  raw_record_id TEXT NOT NULL REFERENCES raw_record(raw_record_id),
  object_version_id TEXT NOT NULL REFERENCES source_object_version(object_version_id),
  ordinal INTEGER NOT NULL,
  raw_bytes_sha256 TEXT NOT NULL,
  PRIMARY KEY(raw_record_id, object_version_id, ordinal)
) STRICT;

CREATE TRIGGER raw_record_no_update BEFORE UPDATE ON raw_record
BEGIN SELECT RAISE(ABORT, 'raw_record is append-only'); END;
CREATE TRIGGER raw_record_no_delete BEFORE DELETE ON raw_record
BEGIN SELECT RAISE(ABORT, 'raw_record is append-only'); END;
CREATE TRIGGER object_no_update BEFORE UPDATE ON source_object_version
BEGIN SELECT RAISE(ABORT, 'source_object_version is append-only'); END;
CREATE TRIGGER object_no_delete BEFORE DELETE ON source_object_version
BEGIN SELECT RAISE(ABORT, 'source_object_version is append-only'); END;
```

`raw_record_id` is `sha256(source_family || native_session_id || native_record_id)` when both native IDs exist. Otherwise it is `sha256(source_family || content_sha256 || ordinal || raw_bytes_sha256)`. `raw_record_source_copy` records duplicate locations without duplicating the canonical payload.

The append transaction order is fixed:

1. Append `ingest_run`.
2. Append every root observation.
3. Append every object version in manifest order.
4. Append every record in native ordinal order, including non-Sol and out-of-window records.
5. Append copy links for already-known records.
6. Append a terminal ingest receipt in a separate immutable manifest file with row counts and hashes.

No classification, model predicate, cohort predicate, or time predicate may run before step 5 commits.

## Derived normalized snapshot schema

The working and frozen analysis databases derive from the append-only corpus. The working database may be rebuilt. Frozen files live under `/Volumes/BBALL_GM_DATA/sol-corpus/snapshots/` and never change.

```sql
CREATE TABLE study (
  study_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  cutoff_utc TEXT NOT NULL,
  corpus_manifest_sha256 TEXT NOT NULL,
  protocol_sha256 TEXT NOT NULL,
  alias_ledger_sha256 TEXT NOT NULL,
  codebook_sha256 TEXT,
  classifier_id TEXT,
  classifier_prompt_sha256 TEXT,
  threshold_version TEXT NOT NULL
) STRICT;

CREATE TABLE snapshot (
  snapshot_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES study(study_id),
  window_days INTEGER NOT NULL CHECK(window_days IN (14,30)),
  lower_utc TEXT NOT NULL,
  cutoff_utc TEXT NOT NULL,
  canonical_content_sha256 TEXT,
  frozen INTEGER NOT NULL CHECK(frozen IN (0,1)),
  UNIQUE(study_id, window_days),
  CHECK(lower_utc < cutoff_utc)
) STRICT;

CREATE TABLE logical_session (
  session_key TEXT PRIMARY KEY,
  native_session_id TEXT,
  identity_basis TEXT NOT NULL CHECK(identity_basis IN ('native_id','content_sha256')),
  source_family TEXT NOT NULL CHECK(source_family IN ('omp','pi','codex')),
  started_at_utc TEXT,
  ended_at_utc TEXT,
  dedup_status TEXT NOT NULL CHECK(dedup_status IN ('unique','identical_copy','strict_superset','conflict')),
  conflict_detail TEXT
) STRICT;

CREATE TABLE event (
  event_key TEXT PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES logical_session(session_key),
  raw_record_id TEXT NOT NULL,
  native_event_id TEXT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  event_at_utc TEXT,
  event_type TEXT NOT NULL,
  speaker_kind TEXT NOT NULL CHECK(speaker_kind IN
    ('jamie','parent_agent','assistant','system','tool','unknown')),
  speaker_evidence TEXT NOT NULL,
  canonical_json_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE model_alias (
  alias_id TEXT PRIMARY KEY,
  raw_model TEXT NOT NULL,
  canonical_model TEXT,
  raw_provider TEXT,
  role_suffix TEXT,
  effort_suffix TEXT,
  source_field TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
  reason TEXT NOT NULL,
  observed_count INTEGER NOT NULL CHECK(observed_count >= 1),
  UNIQUE(raw_model, raw_provider, source_field)
) STRICT;

CREATE TABLE work_unit (
  work_unit_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES logical_session(session_key),
  parent_work_unit_id TEXT REFERENCES work_unit(work_unit_id),
  project_key TEXT,
  role_raw TEXT,
  role_canonical TEXT,
  role_evidence_event_key TEXT REFERENCES event(event_key),
  cohort TEXT NOT NULL CHECK(cohort IN ('jamie_facing','mixed','agent_only','unknown')),
  cohort_basis TEXT NOT NULL,
  cohort_evidence_refs_json TEXT NOT NULL CHECK(json_valid(cohort_evidence_refs_json)),
  started_at_utc TEXT NOT NULL,
  ended_at_utc TEXT,
  terminal_status TEXT NOT NULL CHECK(terminal_status IN
    ('pass','issues','blocked','dnf','void','unknown')),
  outcome_verification TEXT NOT NULL CHECK(outcome_verification IN
    ('verified_success','recovered_success','verified_failure','blocked_external','unverified','censored')),
  outcome_evidence_refs_json TEXT NOT NULL CHECK(json_valid(outcome_evidence_refs_json)),
  right_censored INTEGER NOT NULL CHECK(right_censored IN (0,1)),
  mixed_model INTEGER NOT NULL CHECK(mixed_model IN (0,1)),
  task_digest_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE model_request (
  request_id TEXT PRIMARY KEY,
  work_unit_id TEXT NOT NULL REFERENCES work_unit(work_unit_id),
  event_key TEXT NOT NULL REFERENCES event(event_key),
  requested_model_raw TEXT,
  resolved_model_raw TEXT,
  canonical_model TEXT,
  provider_raw TEXT,
  effort_raw TEXT,
  fallback_state TEXT NOT NULL CHECK(fallback_state IN ('true','false','unknown')),
  attribution_basis TEXT NOT NULL CHECK(attribution_basis IN
    ('completion','source_native_completion','configured_route','benchmark_crosscheck')),
  completed_at_utc TEXT NOT NULL,
  stop_reason_raw TEXT,
  error_message_present INTEGER NOT NULL CHECK(error_message_present IN (0,1)),
  input_tokens INTEGER CHECK(input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens >= 0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK(cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens >= 0),
  total_tokens_native INTEGER CHECK(total_tokens_native >= 0),
  component_sum_tokens INTEGER CHECK(component_sum_tokens >= 0),
  catalog_cost_microusd INTEGER CHECK(catalog_cost_microusd >= 0),
  repriced_cost_microusd INTEGER CHECK(repriced_cost_microusd >= 0),
  usage_basis TEXT NOT NULL CHECK(usage_basis IN ('provider_reported','host_reported','estimated','missing')),
  cost_basis TEXT NOT NULL CHECK(cost_basis IN ('provider_reported','route_pricing','unknown'))
) STRICT;

CREATE TABLE unit_classification (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(snapshot_id),
  work_unit_id TEXT NOT NULL REFERENCES work_unit(work_unit_id),
  task_class TEXT NOT NULL CHECK(task_class IN
    ('investigation','diagnosis_recovery','planning_design','implementation','review',
     'verification','operations_setup','coordination','writing','data_analysis','other','unscored')),
  outcome_label TEXT NOT NULL CHECK(outcome_label IN ('pass','issues','blocked','dnf','void','unknown')),
  utility_label TEXT NOT NULL CHECK(utility_label IN ('useful','mixed','wasted','unscored')),
  waste_reason TEXT CHECK(waste_reason IN
    ('duplicate_work','wrong_task','failed_output','unproductive_loop','avoidable_rework',
     'orchestration_overhead','fallback_contamination','other_evidenced')),
  classification_method TEXT NOT NULL CHECK(classification_method IN ('rule','classifier','human')),
  classifier_id TEXT,
  classifier_prompt_sha256 TEXT,
  codebook_version TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
  confidence REAL CHECK(confidence >= 0 AND confidence <= 1),
  PRIMARY KEY(snapshot_id, work_unit_id)
) STRICT;

CREATE TABLE request_utility (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(snapshot_id),
  request_id TEXT NOT NULL REFERENCES model_request(request_id),
  utility_label TEXT NOT NULL CHECK(utility_label IN ('useful','wasted','unscored')),
  waste_reason TEXT,
  evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
  classification_method TEXT NOT NULL CHECK(classification_method IN ('rule','classifier','human')),
  PRIMARY KEY(snapshot_id, request_id)
) STRICT;

CREATE TABLE lexical_locator_hit (
  hit_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES logical_session(session_key),
  work_unit_id TEXT REFERENCES work_unit(work_unit_id),
  message_event_key TEXT NOT NULL REFERENCES event(event_key),
  speaker_kind TEXT NOT NULL CHECK(speaker_kind = 'jamie'),
  message_id TEXT,
  message_at_utc TEXT NOT NULL,
  match_token TEXT NOT NULL,
  normalized_token TEXT NOT NULL,
  target_lexeme TEXT NOT NULL CHECK(target_lexeme IN ('fuck','retard')),
  method TEXT NOT NULL CHECK(method IN ('exact','stem','damerau_levenshtein','trigram','phonetic')),
  edit_distance INTEGER,
  similarity REAL,
  episode_start_event_key TEXT NOT NULL REFERENCES event(event_key),
  episode_end_event_key TEXT NOT NULL REFERENCES event(event_key),
  validation_label TEXT CHECK(validation_label IN
    ('validated_failure_episode','validated_recovered_episode','quoted_or_meta','unrelated','unreviewed')),
  validation_evidence_refs_json TEXT CHECK(validation_evidence_refs_json IS NULL OR json_valid(validation_evidence_refs_json))
) STRICT;

CREATE TABLE validation_label (
  snapshot_id TEXT NOT NULL REFERENCES snapshot(snapshot_id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('work_unit','request','locator_episode')),
  target_id TEXT NOT NULL,
  stratum TEXT NOT NULL,
  sample_rank INTEGER NOT NULL,
  split TEXT NOT NULL CHECK(split IN ('calibration','holdout')),
  blinded_digest_sha256 TEXT NOT NULL,
  human_task_class TEXT,
  human_outcome_label TEXT,
  human_utility_label TEXT,
  locked INTEGER NOT NULL CHECK(locked IN (0,1)),
  PRIMARY KEY(snapshot_id, target_kind, target_id)
) STRICT;

CREATE TABLE comparison_pair (
  pair_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshot(snapshot_id),
  sol_work_unit_id TEXT NOT NULL REFERENCES work_unit(work_unit_id),
  opus_work_unit_id TEXT NOT NULL REFERENCES work_unit(work_unit_id),
  tier TEXT NOT NULL CHECK(tier IN ('A','B','C')),
  cohort TEXT NOT NULL CHECK(cohort IN ('jamie_facing','mixed','agent_only')),
  match_key TEXT NOT NULL,
  match_distance REAL,
  eligibility_json TEXT NOT NULL CHECK(json_valid(eligibility_json)),
  UNIQUE(snapshot_id, sol_work_unit_id),
  UNIQUE(snapshot_id, opus_work_unit_id)
) STRICT;
```

`total_tokens_native` is the source's total. `component_sum_tokens` sums only components whose semantics are known. Never add reasoning to output unless the source proves reasoning is excluded from output. Unknown tokens and cost stay `NULL`, not zero.

## Deduplication identity

Use:

```text
session_key = "id:" + native_session_id
              when present
session_key = "sha256:" + canonical_event_stream_sha256
              otherwise

event_key = session_key + "/id:" + native_event_id
            when present
event_key = session_key + "/ordinal:" + ordinal + "/sha256:" + canonical_json_sha256
            otherwise

request_id = session_key + "/response:" + native_response_id
             or session_key + "/event:" + event_key
```

The native session ID is global across MacBook and HDD copies. Do not include pathname, source root, provider, or role in `session_key`.

For copies of one session:

1. Canonicalize object keys only for hashing. Preserve arrays and strings.
2. Require equal payload hashes for matching native event IDs.
3. Select a strict superset when every shorter-copy event appears unchanged in the longer copy.
4. Break identical-copy ties by valid-event count, last event time, size, then SHA-256.
5. Mark a fork or incomparable partial streams `conflict`. Exclude the logical session until resolved.

One logical session contributes each event and request once. Duplicate-ID SQL checks must return zero rows.

## Sol identity, role, effort, and fallback

Identity uses a versioned alias ledger. Initial observed variants include:

```text
cli-proxy/codex.gpt-5.6-sol
cli-proxy/codex.gpt-5.6-sol.manager
cli-proxy/codex.gpt-5.6-sol.reviewer
cli-proxy/codex.gpt-5.6-sol.designer
cli-proxy/codex.gpt-5.6-sol.synthesizer
cli-proxy/codex.gpt-5.6-sol.security-reviewer
cli-proxy/codex.gpt-5.6-sol.coordinator
openai-codex/gpt-5.6-sol
openai-codex/gpt-5.6-sol:high
openai-codex/gpt-5.6-sol:xhigh
gpt-5.6-sol
```

Candidate discovery applies this anchored pattern only to authoritative model fields:

```regex
(?:^|/)(?:codex\.)?gpt-5\.6-sol(?:\.[a-z0-9-]+)*(?::[a-z0-9-]+)?$
```

A hit is a candidate, not automatic acceptance. Gate on zero unresolved in-window candidates. Explicitly reject Luna and every other base model even if the route resembles Sol.

Evidence order per request:

1. Actual assistant completion model and provider.
2. Source-native completion metadata such as Pi `api/provider/model` or Codex completion metadata.
3. Most recent preceding authoritative route record. OMP uses `model_change.model`; Pi uses `model_change.provider` and `modelId`; Codex uses `turn_context.model` or `thread_settings_applied.model` and `provider_id`.
4. Benchmark actor attribution only as a cross-check.

Preserve requested and resolved values. Provider is secondary. Role has an independent alias ledger. Prefer benchmark actor role or explicit actor record; use subagent label only when the format proves the relationship. Filename alone is not evidence.

Effort is `low`, `medium`, `high`, `xhigh`, `none`, or `unknown`, plus the raw field. Fallback is three-valued. Use `true` when recorded or actual differs from requested, `false` only with explicit evidence, and `unknown` otherwise. Pi attempts, OMP `resolvedModelIsFallback`, and benchmark actor fallback are evidence.

## Authoritative cohort rules

A JSON message role of `user` is not enough to identify Jamie. Subagent briefs often use that role. Normalize speaker provenance first.

Evidence fields by source:

- OMP: top session ID, parent session relationship, child-directory relationship, agent/subagent label, root versus child source, and message IDs.
- Pi: session parent fields, `source.subagent`, model-attempt artifact metadata, and message IDs.
- Codex: `parent_thread_id`, `source.subagent`, `thread_source`, `originator`, and message IDs.
- Benchmark cross-check: `actors.parent_actor_id`, `actors.session_id`, `actors.role`, and run hierarchy.

Assign one cohort per work unit:

- `jamie_facing`: no explicit parent-agent or subagent relationship, source says main/root/user thread, and at least one message is authoritatively attributable to Jamie.
- `agent_only`: explicit parent-agent or subagent relationship, the assignment came from a parent actor, and no message is independently attributable to Jamie.
- `mixed`: the same work unit contains both independently attributable Jamie input and explicit parent-agent input. A Jamie-facing root that merely spawns separate child work remains Jamie-facing; its child work is agent-only.
- `unknown`: evidence cannot distinguish the three. Exclude it from cohort rates and report its count and tokens.

Store every cohort evidence reference. A path-derived parent link must agree with the native parent/session fields or become a conflict.

Outcome verification is also cohort-aware:

- `verified_success`: the requested artifact or evidence exists and the parent or Jamie accepts it, or a behavioral verification proves it. A terminal `PASS` string alone is insufficient.
- `recovered_success`: a documented failure or correction is followed by a verified fix within the same work unit.
- `verified_failure`: terminal evidence proves a wrong, missing, unusable, or abandoned deliverable and no later verified recovery exists.
- `blocked_external`: a prerequisite outside the actor is missing and the actor stops without avoidable churn.
- `unverified`: only self-report or ambiguous evidence exists.
- `censored`: the work continues beyond the cutoff.

For each cohort use:

```text
decided_units = verified_success + recovered_success + verified_failure
success_rate = (verified_success + recovered_success) / decided_units
failure_rate = verified_failure / decided_units
recovery_rate = recovered_success / decided_units
```

`blocked_external`, `unverified`, `censored`, and `unknown` stay outside the denominator and remain separate counts and token totals. Report Wilson 95% intervals. Report unit-weighted success/failure and token-weighted waste separately. Never pool cohorts before printing all three rates.

Do not compare raw complaint-language frequency between cohorts. Agent-only lanes receive structured parent feedback rather than Jamie's language. Complaint locators apply only to Jamie-authored messages in Jamie-facing or mixed cohorts. Agent-only complaint rate is `not_applicable`, not zero.

## Jamie-authored lexical locators

Run lexical search only after speaker and cohort attribution. It is a high-recall episode locator, never an automatic failure label.

Normalize Jamie-authored tokens with Unicode NFKC, lowercase, and punctuation removal while retaining the original token. Search target families around `fuck` and `retard`, including exact forms, inflections, and misspellings such as `fucking`, `fucign`, and `fuckuck`.

Candidate methods:

1. Exact or prefix/stem matches for `fuck`, `fucking`, `fucked`, `retard`, and `retarded`.
2. Damerau-Levenshtein distance at most 2 for token length 4 through 9 against the frozen lexeme list. Permit distance 3 only when normalized distance is at most 0.34.
3. Character-trigram Jaccard similarity at least 0.45 for candidates missed by edit distance.
4. A phonetic candidate may be stored, but it cannot validate an episode without manual context.

Store match token, normalized token, target lexeme, distance, method, similarity, message ID, session ID, timestamp, cohort, and speaker evidence. Define episode boundaries deterministically: start at the nearest preceding Jamie-authored task message or work-unit start; end at the first subsequent new-target Jamie message, terminal evidence, or work-unit end. Store both event IDs.

Manual review reads the bounded episode and assigns `validated_failure_episode`, `validated_recovered_episode`, `quoted_or_meta`, `unrelated`, or `unreviewed`. Only a validated episode may support an outcome label, and the outcome still requires deliverable evidence. Preserve false positives. Do not calculate Sol failure from token presence.

## Task, outcome, and request utility classification

Use the actor's explicit assignment as one work unit. Split a session only at a source-native task boundary or a Jamie/parent message with a new target. Do not split on assistant topic words. Ambiguous multi-topic work is `unscored`.

Primary task classes:

```text
investigation, diagnosis_recovery, planning_design, implementation,
review, verification, operations_setup, coordination, writing,
data_analysis, other, unscored
```

Classify from the requested deliverable, not role name. Outcome and utility stay separate. A reported error can be useful evidence. A correction is not automatically model failure. External blockage is not waste unless requests continue after the blocker without useful work.

Label each Sol request:

- `useful`: produced evidence, an artifact, a decision, or a necessary intermediate step used by completed work.
- `wasted`: no usable contribution because it duplicated accepted work, pursued the wrong target, failed to yield output, looped without evidence, caused avoidable rework, or added unnecessary coordination.
- `unscored`: evidence supports neither.

Compute:

```text
wasted_tokens = sum(total_tokens_native where request utility = wasted)
scored_tokens = sum(total_tokens_native where request utility in {useful,wasted})
token_label_coverage = scored_tokens / all reported Sol tokens
waste_share = wasted_tokens / scored_tokens
```

Do not include estimated tokens in the reported-token denominator. Do not treat unscored as useful.

The classifier receives a compact digest with event IDs, task text, tool summaries, terminal evidence, corrections, cohort, and outcome evidence. It does not receive model, provider, source root, comparison cohort, cost, lexical-locator result, or prior label. Use neither Sol nor the compared Opus cohort. The initial route is `anthropic/claude-sonnet-4-6` because `audit.ts` supports it, but its output is accepted only after holdout validation.

## Deterministic command interface

The implementation adds `scripts/session-stats/sol-study.ts` inside the existing owner.

```sh
bun scripts/session-stats/sol-study.ts discover \
  --study local/sol-corpus/study-v1.toml \
  --cutoff 2026-08-29T00:00:00Z \
  --out /Volumes/BBALL_GM_DATA/sol-corpus/manifests/source-manifest-v1.json

bun scripts/session-stats/sol-study.ts append \
  --manifest /Volumes/BBALL_GM_DATA/sol-corpus/manifests/source-manifest-v1.json \
  --corpus /Volumes/BBALL_GM_DATA/sol-corpus/corpus.sqlite \
  --receipt /Volumes/BBALL_GM_DATA/sol-corpus/manifests/ingest-v1.json

bun scripts/session-stats/sol-study.ts verify-corpus \
  --corpus /Volumes/BBALL_GM_DATA/sol-corpus/corpus.sqlite \
  --manifest /Volumes/BBALL_GM_DATA/sol-corpus/manifests/source-manifest-v1.json

bun scripts/session-stats/sol-study.ts derive \
  --corpus /Volumes/BBALL_GM_DATA/sol-corpus/corpus.sqlite \
  --study local/sol-corpus/study-v1.toml \
  --aliases /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/model-aliases-v1.tsv \
  --lower 2026-07-30T00:00:00Z --cutoff 2026-08-29T00:00:00Z \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-work-v1.sqlite

bun scripts/session-stats/sol-study.ts freeze \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-work-v1.sqlite \
  --window 14d \
  --out /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite

bun scripts/session-stats/sol-study.ts locate-episodes \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite \
  --speaker jamie --lexemes fuck,retard --fuzzy-config local/sol-corpus/locator-v1.yml

bun scripts/session-stats/sol-study.ts classify \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite \
  --codebook /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/codebook-v1.yml \
  --classifier anthropic/claude-sonnet-4-6 \
  --blind model,provider,source,cost,locator,prior-label

bun scripts/session-stats/sol-study.ts sample-validation \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite \
  --seed-from canonical_content_sha256 \
  --out /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/validation-sample-v1.tsv

bun scripts/session-stats/sol-study.ts decide \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite \
  --threshold-version sol-study-v1 \
  --unit-out /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/unit-decisions-14d-v1.tsv \
  --class-out /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/task-class-decisions-14d-v1.tsv
```

After two-week gates pass, repeat `freeze`, `locate-episodes`, `classify`, `verify`, and `decide` with `--window 30d`. Reuse the same corpus receipt, cutoff, aliases, codebook, classifier prompt, cohort rules, and thresholds.

Determinism predicates:

- Parse objects in manifest order and records in native ordinal order.
- IDs come from native IDs or SHA-256.
- Sort derived inserts by primary key.
- Seed samples and bootstraps from snapshot content hash.
- Store executable version, parser version, prompt hash, codebook hash, alias hash, cohort-rule hash, and corpus receipt hash.
- Rebuilds must match a canonical ordered row-content digest. SQLite binary SHA identifies one artifact but is not the rebuild predicate.

## Riskiest-unknown-first phases

| Phase | Work | Falsifiable exit predicate | Failure action |
| --- | --- | --- | --- |
| 0. Freeze protocol | Write exact sources, windows, aliases, cohort rules, lexical locator, and thresholds. | Every command receives one protocol SHA and cutoff. | Change means new version. |
| 1. Prove formats and identities | Inspect headers, parent/session fields, route records, speakers, and one completion shape per source format. | Every format has a parser result; unresolved in-window Sol candidates = 0; non-Sol control false positives = 0; cohort evidence fields mapped. | Fix parser or alias before bulk append. |
| 2. Freeze provenance | Bounded inventory and hash of every root, object, database snapshot, archive, and member. | Required roots are complete or outside window; second inventory has same manifest hash. | No global conclusion while required source is unavailable. |
| 3. Append everything | Append all discovered records into HDD corpus with no analysis filter. | Source/object/record counts equal receipt; append-only triggers reject update/delete; source bytes unchanged. | Roll back incomplete transaction; never repair source in place. |
| 4. Normalize and dedup | Build logical sessions, parent links, speakers, cohorts, roles, model requests, and usage. | Dedup conflicts = 0; all Sol requests have accepted alias and evidence; unknown fallback stays explicit; cohort unknowns reported. | Resolve or exclude whole unit with reason. |
| 5. Freeze and pilot 14 days | Create snapshot, locate Jamie episodes, classify blinded work. | Snapshot time checks pass; locator speaker is Jamie on every hit; classifier JSON and evidence references validate. | Invalid records become unscored. |
| 6. Human checkpoint | Blind review aliases, cohort edge cases, locator episodes, tasks, outcomes, and utility. Tune only calibration. | Holdout macro-F1 >= 0.80, kappa >= 0.75, identity accuracy = 1.00, cohort accuracy = 1.00, no source family precision/recall below 0.70. | Gate fails; method change starts v2. |
| 7. Two-week decision | Reclassify with locked artifacts and calculate separate cohort rates. | Unit and token label coverage >= 0.90; all three cohort reports reproduce from stored SQL. | Output insufficient evidence. |
| 8. Extend to month | Freeze 30-day view from same corpus and repeat locked workflow. | Every 14-day request appears unchanged in 30-day snapshot; 14-day aggregates reproduce as a subset. | Stop on drift. |
| 9. Opus comparison | Pair within cohort and eligibility tier. | No unit reused; every pair passes predicates; Tier A and B remain separate. | Report no comparison. |
| 10. Persist and report | Write TSV/report and metadata-only benchmark rows. | Hashes match; benchmark validates on disposable copy; counts equal snapshots. | Live benchmark remains unchanged. |

## Manual-validation sampling

Build one deterministic sample from the two-week snapshot:

1. Include every dedup conflict, fallback, mixed-model, cohort-unknown, parser-partial, classifier-invalid, and lexical-locator episode.
2. Include the 20 highest-token work units.
3. Include each source-family, cohort, role, task-class, and predicted-utility stratum at least twice when possible.
4. If there are 80 or fewer units, label all. Otherwise label `max(80, ceil(0.15 * N))`, capped at 250 after mandatory inclusions.
5. For each sampled unit, include its largest-token Sol request and up to four hash-ranked requests.
6. Assign 40% calibration and 60% holdout from `SHA256(snapshot_hash || target_id)` before labels exist.

The human sees blinded digests without model, provider, cost, locator method, or classifier prediction. The checkpoint locks labels. Quality gates:

- Sol identity precision and recall = 1.00.
- Cohort assignment accuracy = 1.00.
- Provenance and dedup match source evidence on every mandatory case.
- Task and request-utility macro-F1 >= 0.80 on holdout.
- Kappa >= 0.75 for task, outcome, and utility.
- No source family with at least five holdout records has precision or recall below 0.70.
- Every disagreement remains stored with both labels and evidence.

These are study acceptance policies, not claims about a classifier or model.

## Opus comparison eligibility

Canonicalize Opus through its own alias ledger. Pair only within the same cohort.

- Tier A controlled: same frozen task/benchmark ID, input hashes, project tree/checkpoint, task brief hash after model-name removal, role, allowed tools, and time budget. Both single-model, terminal, fallback false, and complete usage. Only Tier A can support model-quality or replacement language.
- Tier B matched observation: match without replacement on cohort, project, source family, task class, role, task-brief token decile, declared scope, effort, and start date within seven days. Use only pre-completion attributes. This supports descriptive association only.
- Tier C descriptive: same cohort and task class without a valid pair. Report distributions only.

Exclude censored, mixed-model, fallback true or unknown, dedup-conflicted, parser-partial, unverified, missing-usage, or unscored units. Use seeded paired BCa bootstrap with 9,999 resamples for Tier A. Keep actual-route cost separate from model identity.

## Per-unit verification

`verify` writes one row per check and exits nonzero on required failure.

| Unit | PASS predicate |
| --- | --- |
| Source root | Complete or outside window; unavailable required root blocks global conclusion. |
| Source object | Bytes match manifest hash and source path remains unchanged. |
| Corpus append | Receipt counts match; every source record has a canonical row or parse-error row. |
| Append-only | Update and delete probes fail with the trigger error. |
| Session | One native ID maps to one compatible stream; no unresolved conflict. |
| Event | Key is unique and canonical JSON hash recomputes. |
| Speaker | Jamie or parent-agent attribution cites authoritative fields; `user` role alone fails. |
| Cohort | Rules and evidence refs produce one cohort; unknown stays explicit. |
| Work unit | Explicit assignment supports boundaries; outcome has external evidence or is unverified/censored. |
| Sol request | Accepted alias and authoritative field support canonical identity. |
| Provider, role, effort | Raw value and evidence stored; unknown is not guessed. |
| Fallback | Explicit state; missing evidence becomes unknown. |
| Usage/cost | Present values nonnegative; native total separate; missing is NULL. |
| Locator | Speaker is Jamie; match metadata and episode boundaries exist; no automatic failure label. |
| Classification | Label validates and cites existing events. |
| Snapshot | `lower <= completed_at < cutoff`; 14-day set is a strict subset of 30-day set. |
| Comparison | Same cohort, tier predicates pass, no reused unit. |

Required SQL includes `PRAGMA foreign_key_check`, `PRAGMA quick_check`, zero dedup conflicts, zero unresolved Sol candidates, zero out-of-window snapshot rows, and zero missing 14-day rows in the month snapshot.

## Decision TSVs

`unit-decisions-*.tsv` columns:

```text
study_id, snapshot_id, window_days, cutoff_utc, work_unit_id, source_family,
source_id, session_key, project_key, parent_work_unit_id, role_raw,
role_canonical, cohort, cohort_basis, task_class, started_at_utc, ended_at_utc,
terminal_status, outcome_verification, outcome_label, utility_label,
waste_reason, evidence_refs, locator_hit_count, validated_failure_episode_count,
sol_request_count, input_tokens, output_tokens, cache_read_tokens,
cache_write_tokens, reasoning_tokens, total_tokens_native, scored_tokens,
wasted_tokens, catalog_cost_usd, repriced_cost_usd, cost_basis,
requested_model_raw, resolved_model_raw, canonical_model, provider_raw,
effort_raw, fallback_state, mixed_model, right_censored, usage_coverage,
classifier_id, classifier_prompt_sha256, codebook_version, human_validated,
comparison_tier, opus_work_unit_id, exclusion_reason
```

`task-class-decisions-*.tsv` columns:

```text
study_id, snapshot_id, cohort, task_class, role_canonical, eligible_units,
decided_units, scored_units, blocked_external_units, unverified_units,
censored_units, unit_label_coverage, reported_tokens, scored_tokens,
token_label_coverage, verified_successes, recovered_successes,
verified_failures, success_rate, success_ci_low, success_ci_high,
failure_rate, failure_ci_low, failure_ci_high, recovery_rate, useful_units,
mixed_units, wasted_units, waste_share, waste_share_ci_low,
waste_share_ci_high, catalog_cost_usd, repriced_cost_usd,
opus_tier_a_pairs, opus_tier_b_pairs, tier_a_success_delta,
tier_a_success_ci_low, tier_a_success_ci_high, tier_a_token_ratio,
tier_a_cost_ratio, decision, threshold_version, evidence_query_sha256
```

Use empty fields for SQL NULL. Never print zero for unknown usage or cost. Sort unit rows by snapshot, cohort, task, role, start, and ID. Print cohort rows first, then an explicitly labeled all-cohort rollup. Never use the rollup without the cohort rows.

## Final thresholds

Apply final thresholds only to the month. A task-class and cohort row is eligible when:

- `decided_units >= 20`;
- unit-label and token-label coverage are each at least 0.90;
- required source coverage and holdout gates pass;
- dedup conflicts are zero;
- at least 90% of eligible units have provider- or host-reported usage.

Use Wilson 95% intervals for unit rates and seeded BCa intervals for token shares.

- `USE_SOL`: success-rate lower bound >= 0.60, waste-share upper bound <= 0.25, and failure-rate upper bound <= 0.15.
- `AVOID_SOL`: success-rate upper bound < 0.50, waste-share lower bound > 0.40, or failure-rate lower bound > 0.20.
- `USE_SOL_SELECTIVELY`: eligible but neither rule fires. Report only predeclared role or effort subgroups with at least 10 decided units.
- `INSUFFICIENT_EVIDENCE`: any gate fails or intervals do not support a decision.

A `USE_SOL` row does not mean Sol beats Opus. `REPLACE_OPUS_WITH_SOL` requires at least 15 Tier A pairs within the same cohort, a one-sided 95% lower bound for Sol minus Opus success >= `-0.05`, an upper bound for Sol minus Opus waste share <= `+0.05`, and either 15% fewer reported tokens per success or 10% lower actual-route cost per success. No paired severe failure may exist only in the Sol arm. Fewer pairs produce `NO_REPLACEMENT_CONCLUSION`. Tier B never satisfies replacement.

These thresholds are governance policy, not unsupported model-quality assumptions.

## Benchmark persistence

Extend `/Users/jamie/.omp/benchmarks/omp-benchmark.ts` with one owned command:

```sh
bun /Users/jamie/.omp/benchmarks/omp-benchmark.ts \
  --db /tmp/omp-benchmarks-sol-study.sqlite \
  ingest-study-summary /Volumes/BBALL_GM_DATA/sol-corpus/artifacts/benchmark-summary-30d-v1.json
```

Validate a disposable copy before the live transaction. Use `run_id=study:sol-corpus:20260829:30d:v1`, `source_kind=sol-corpus-study`, exact bounds, snapshot path/hash, `measurement_version=1`, and `privacy_class=metadata-only`. `run_outcome` describes workflow completion, not Sol quality. `measurement_status=PASS` only when provenance, extraction, validation, and coverage gates pass.

Persist one actor per work unit with cohort, role, requested route, resolved provider/model, effort, fallback, terminal status, and snapshot evidence reference. Persist metadata measurements for token components, costs, requests, wasted tokens, task, utility, cohort rates, coverage, holdout metrics, and decisions. Persist artifact paths, hashes, and sizes. Do not persist prompts, messages, tool bodies, or episode text.

Re-ingesting identical IDs and hashes is idempotent. A conflicting hash rejects the transaction unless the study version changes.

## Completion proof

The study is complete only when these interfaces succeed against frozen artifacts:

```sh
bun scripts/session-stats/sol-study.ts verify-corpus \
  --corpus /Volumes/BBALL_GM_DATA/sol-corpus/corpus.sqlite \
  --manifest /Volumes/BBALL_GM_DATA/sol-corpus/manifests/source-manifest-v1.json

bun scripts/session-stats/sol-study.ts verify \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-14d-v1.sqlite --level all

bun scripts/session-stats/sol-study.ts verify \
  --db /Volumes/BBALL_GM_DATA/sol-corpus/snapshots/sol-20260829-30d-v1.sqlite --level all

bun scripts/session-stats/sol-study.ts reproduce \
  --study local/sol-corpus/study-v1.toml \
  --expect-content-sha256 <recorded-30d-content-sha256>

bun /Users/jamie/.omp/benchmarks/omp-benchmark.ts \
  --db /tmp/omp-benchmarks-sol-study.sqlite validate
```

The report states source coverage, parser coverage, cohort denominators, label coverage, holdout scores, sample sizes, locator validation counts, exclusions, confidence intervals, and the exact decision predicate that fired. Missing evidence yields `INSUFFICIENT_EVIDENCE`, never an assumption.

