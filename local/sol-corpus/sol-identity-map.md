# GPT-5.6 Sol identity map

Status: **PASS (evidence-bounded)**

## Canonical identity and final predicate

Canonical normalizer key: `gpt-5.6-sol`.

**Final strong-match predicate:** inspect only structured `model`, `route`, `resolved_model`/`resolvedModel`, or equivalent runtime attribution fields. Normalize the model token by lowercasing and treating `.`, `_`, spaces, and hyphens as separators. A record matches Sol iff the normalized model token is exactly either:

- `gpt-5.6-sol`
- `codex.gpt-5.6-sol`

A qualifying token may carry any structured role suffix: `base`, `manager`, `reviewer`, `designer`, `synthesizer`, `security-reviewer`, `coordinator`, `advisor`, or another explicitly recorded role. It may be prefixed by any provider (`cli-proxy`, `openai-sub`, `openai-codex`, `gpai`, etc.) and suffixed by an effort marker such as `:low`, `:high`, or `:xhigh`. Preserve all dimensions; never let role or effort alter identity. Prose, filenames, lane labels, and quoted text are never attribution evidence.

The historically observed exact route is `cli-proxy/codex.gpt-5.6-sol.manager` (S01). `openai-codex/gpt-5.6-sol:xhigh` is also a structured direct-provider Sol spelling (S03). `resolvedModelIsFallback` is independent: observed `false` in S02's exact-route records; absent means `unknown`.

## Alias and field map

| Strength | Observed string/field | Canonical interpretation | Evidence |
|---|---|---|---|
| Strong | `cli-proxy/codex.gpt-5.6-sol.manager` | Sol; provider `cli-proxy`; role `manager` | S01 exact top-level `model_change.model`; S02 route predicate |
| Strong | `openai-codex/gpt-5.6-sol:xhigh` | Sol; direct provider; effort `xhigh` | `/Users/jamie/.omp/WATCHDOG.yml.parked:67` |
| Strong when structured | `gpt-5.6-sol`, `codex.gpt-5.6-sol` plus any listed role/provider/effort | Sol; preserve suffix dimensions | Final predicate above |
| Strong when structured | OpenAI-sub and GPAI variants whose normalized model token is exactly `gpt-5.6-sol` or `codex.gpt-5.6-sol` | Sol; provider is retained, not discarded | Final predicate; provider family required as a field, not a lexical proof |
| Rejected | `openai-sub/codex.gpt-5.6-luna` | Luna, not Sol | `/Users/jamie/.omp/agent/agents/assistant.md:5`; `herdr-ops.md:10` |
| Rejected | `roles/role-manager` without resolved model | Role indirection, identity unknown | `/Users/jamie/.omp/README.md:24-26,35-38` |
| Rejected | `Sol`/`sol` only in prose, filename, lane name, or quoted text | No structured attribution | S01 attribution rule |

## Separate dimensions

```text
provider_prefix   // cli-proxy, openai-sub, openai-codex, gpai, etc.
model_token       // exact normalized gpt-5.6-sol or codex.gpt-5.6-sol
role_suffix       // base, manager, reviewer, designer, synthesizer, security-reviewer, coordinator, advisor, ...
effort_suffix     // low, high, xhigh, or explicit effort field
resolved_model    // runtime-resolved upstream name, if present
fallback          // resolvedModelIsFallback: true, false, or unknown
prompt_family     // prompt/task family, retained separately
source_id         // stable inventory source ID
raw_value         // original unnormalized field
```

## Stable source inventory

### S01 — OMP exact-route inventory
- Root: `/Users/jamie/.omp/agent/sessions/**/*.jsonl`
- Format: JSONL session transcripts; top-level `model_change` records plus nested messages.
- Snapshot: 5,650 JSONL files reported; live corpus may grow.
- Exact route: `cli-proxy/codex.gpt-5.6-sol.manager`.
- Deduplicated result: 75 sessions, 192 routed user records, 4,560 assistant records.
- Citations: `/Users/jamie/Projects/omp-owned/local/gpt56-sol-corpus-inventory.md:1-4`; `/Users/jamie/Projects/omp-owned/local/gpt56-sol-success-baseline.md:7-8`.

### S02 — Frozen OMP extraction
- Root: same OMP archive; JSONL.
- Cutoff: `2026-08-28T12:20:42.448Z`.
- Result: 75 frozen sessions; 266 nested user-text records; 4,641 assistant records; fallback observed false in exact-route records.
- Citation: `/Users/jamie/Projects/omp-owned/local/gpt56-sol-full-episodes-final.md:5-23`.

### S03 — OMP setup/config documentation
- Roots: `/Users/jamie/.omp/README.md`, `/Users/jamie/.omp/agent/agents/*.md`, `/Users/jamie/.omp/WATCHDOG.yml.parked`.
- Format: Markdown/YAML role definitions and watchdog config.
- Observed dimensions: model route, role, effort, fallback/direct-provider notes.
- Citations: README `:24-26,35-38`; assistant `:5`; herdr-ops `:10,30-33`; watchdog `:66-68`.

### S04 — Codex archive root (MacBook)
- Root: `/Users/jamie/.codex/`.
- Format: SQLite (`logs_2.sqlite`, `state_5.sqlite`, `goals_1.sqlite`) plus WAL/SHM and rollout/archive files.
- Structured model/provider fields must be extracted before classifying records; no strong Sol claim is made here from bounded reads.

### S05 — HDD archive roots
- Roots: `/Volumes/BBALL_GM_DATA/offloaded-from-mac/`, `/Volumes/BBALL_GM_DATA/OLD DRIVE/`.
- Formats: directory trees, archives, old project/config material.
- No strong HDD Sol match was established by bounded reads; classify only structured fields using the final predicate.

## Normalizer rules

1. Read structured model/route/resolved-model fields; retain raw value.
2. Normalize case and separators for comparison only.
3. Match exactly `gpt-5.6-sol` or `codex.gpt-5.6-sol` after normalization; role/provider/effort suffixes are dimensions, not disqualifiers.
4. Preserve provider (`cli-proxy`, `openai-sub`, `openai-codex`, `gpai`, etc.), role, effort, resolved model, fallback, prompt family, and source ID.
5. Map fallback true→`fallback`, false→`direct`, absent→`unknown`.
6. `roles/role-*` remains unknown until a structured resolved model links it.

## False-match exclusions

Reject Luna (`gpt-5.6-luna`), near strings (`gpt-5.6-sol-mini`, `gpt-5.6-solar`, `gpt-5.6-solution`), ordinary `sol`/`solution` prose, quoted/copied route text, filenames, and role-only aliases. Deduplicate derived transcript copies by session ID before counting.
