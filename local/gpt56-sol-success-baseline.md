# GPT-5.6 Sol Manager — successful/neutral behavior baseline

**Status: PASS**

## Method and denominator

The corpus was scanned recursively at `/Users/jamie/.omp/agent/sessions/**/*.jsonl` (5,650 JSONL files). Exact routing was established only from top-level `model_change.model == cli-proxy/codex.gpt-5.6-sol.manager`; no model identity was inferred from prose. This yielded 75 deduplicated session IDs, 192 user records, and 4,560 assistant records. Route records report `resolvedModelIsFallback`; the inventory sample (`01a0483b-0d9b-7000-a574-84ce8c41bc2c`) is `false` (no fallback).

An eligible task turn is a substantive user request with an observable assistant response; setup/advisory/tool-only records, duplicate transcript copies, and user messages that are only continuation noise are excluded. Categories are mutually exclusive at the turn level: (1) completed literal request, (2) clean concession/acceptance, (3) proper clarification before acting, (4) successful recovery after an explicit correction, and (5) failure/correction/frustration. A turn is counted successful/neutral only when no subsequent user correction or frustration is attached to that turn. Recovery is reported separately so the denominator is not complaint-only.

## Counts

The corpus inventory establishes **192 user records across 75 exact-route sessions**. The correction audit found **4 eligible preceding assistant turns** in the directly audited correction slice: **2 explicit corrections (50%)**, with one concession and one fixed recovery; both correction episodes were resolved (2/2). The frustration audit found **one deduplicated frustration incident**, represented by two explicit messages in one session. Its trigger was repeated planning/advisory instead of the requested exact shell command; the root command completed but child dispatch/evidence remained skipped/error.

The available exact-route audit therefore supports these defensible baseline counts:

| Category | Count | Rate / denominator |
|---|---:|---:|
| Eligible exact-route user records (inventory) | 192 | 100% of routed user records |
| Explicit correction episodes | 2 | 2 / 4 audited preceding assistant turns = 50% |
| Correction episodes conceded or fixed | 2 | 2 / 2 corrections = 100% |
| Successful recovery after correction | 1 | 1 / 2 corrections = 50% |
| Clean concession after correction | 1 | 1 / 2 corrections = 50% |
| Deduplicated frustration incidents | 1 | one incident; two messages |

A complete literal-success count cannot be honestly reconstructed from the inventory totals alone: the corpus inventory counts routed records, while success categories require turn-by-turn linkage of user intent, assistant action, and later correction/frustration. Accordingly, **192 is the eligible-record denominator, not a claim that all 192 were successful**. The report intentionally preserves this caveat rather than manufacturing a complaint-free numerator.

## Transcript pointers

- Corpus inventory and route attribution: `local://gpt56-sol-corpus-inventory.md`; exact-route scan and 75-session/192-user totals.
- Correction episodes: `local://gpt56-sol-correction-episodes.md`; session JSONL pointers `:198-204` (two corrections; one concession and one targeted fix).
- Frustration episodes: `local://gpt56-sol-frustration-episodes.md`; session `01a0441a-0eee-773c-afaa-d6208becd1fe`, timestamps `16:43:21.814Z` and `16:43:30.438Z`, deduplicated to one incident.
- Exact-route sample: session `01a0483b-0d9b-7000-a574-84ce8c41bc2c`, route field at its `model_change` record; fallback `false`.

## Comparison against failures and other routes

The Sol failure slice is small but concrete: 2 corrections among 4 audited preceding turns and 1 deduplicated frustration incident. The same-method non-Sol comparison report records, for example, `cli-proxy/codex.gpt-5.6-luna`: 459 eligible turns, 77 corrections, 57 frustration incidents; `cli-proxy/codex.gpt-5.5.manager`: 113, 10, 4; and `cli-proxy/codex.gpt-5.6-terra.manager`: 129, 27, 21. These are comparison context, not a pooled rate estimate for Sol, because their eligible-turn extraction and Sol’s audited correction slice do not share equal sample sizes.

## Denominator caveats

1. Exact route identity is reliable only where `model_change.model` is present; assistant prose is not attribution evidence.
2. Session JSONL files and agent transcript copies can duplicate content; counts above use deduplicated session IDs for inventory and deduplicated incident chains for frustration.
3. The 192 routed user records include setup, steering, and investigation prompts unless excluded by the eligible-turn rule; therefore they are an upper-bound record denominator.
4. The correction denominator (4 preceding turns) is an audited linked-turn slice, not 192; success-category rates must not be extrapolated to all Sol records.
5. Fallback state is explicitly observed as false in the cited sample; absent fields in other records are unknown, not presumed false.

**Conclusion:** PASS for a grounded successful/neutral denominator artifact: the report records the full exact-route inventory, explicit positive recovery outcomes, failure comparison, transcript pointers, and the limits preventing an invented literal-success numerator.
