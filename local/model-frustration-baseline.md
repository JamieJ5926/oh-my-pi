# Non-Sol routed-model frustration/correction baseline

**Status: PASS (descriptive baseline; no causal or family-ranking claim).**

## Scope and method

Corpus: `/Users/jamie/.omp/agent/sessions/**/*.jsonl`, 5,650 JSONL files inspected by a recursive parse. The corpus contains duplicated/derived agent transcripts; sessions were deduplicated by the authoritative `type=session` session ID. Route attribution uses the explicit `type=model_change` `model` field and `resolvedModelIsFallback`; no model identity was inferred from prose. This report excludes routes containing `.sol.` and reports explicit non-Sol IDs only.

Eligible turn = a deduplicated session's user message with textual content (string or structured content list). Correction signal = explicit user correction markers such as “no,”, “wrong”, “you misunderstood”, “I said”, “do not/don't”, “correction”, or “stop”. Frustration signal = explicit negative reaction markers such as “frustrat…”, “annoy…”, “ugh”, “again”, “still wrong”, “why did you”, “this is not”, or “not what I asked”. These are conservative lexical screeners, not sentiment inference. Counts are episode candidates; a single user turn counts at most once per metric. Repeated-failure-after-correction was not safely computable from this aggregate pass because it requires pairing each correction with the immediately following assistant action; therefore it is reported as **not measured**, not zero.

Rates below are raw count / eligible turns; session-normalized rates are count / sessions. Sparse groups (fewer than 10 sessions or fewer than 30 eligible turns) are shown for completeness but support no comparative claim.

## Exact route counts (non-Sol)

| Exact route | Sessions | Eligible turns | Corrections | Frustration | Correction rate | Frustration rate | Fallback states |
|---|---:|---:|---:|---:|---:|---:|---|
| `anthropic-sub/claude-official` | 20 | 315 | 22 | 18 | 6.98% | 5.71% | false |
| `anthropic/claude-fable-5` | 14 | 824 | 42 | 22 | 5.10% | 2.67% | false |
| `anthropic/claude-opus-4-6` | 13 | 473 | 24 | 14 | 5.07% | 2.96% | false |
| `cli-proxy/claude.claude-opus-5` | 58 | 134 | 19 | 25 | 14.18% | 18.66% | false |
| `cli-proxy/codex.gpt-5.5.manager` | 45 | 113 | 10 | 4 | 8.85% | 3.54% | false |
| `cli-proxy/codex.gpt-5.6-luna` | 184 | 459 | 77 | 57 | 16.78% | 12.42% | false,true |
| `cli-proxy/codex.gpt-5.6-luna.explorer` | 220 | 291 | 45 | 43 | 15.46% | 14.78% | false |
| `cli-proxy/codex.gpt-5.6-luna.implementer` | 39 | 123 | 21 | 14 | 17.07% | 11.38% | false |
| `cli-proxy/codex.gpt-5.6-luna.mechanical` | 221 | 437 | 73 | 42 | 16.70% | 9.61% | false |
| `cli-proxy/codex.gpt-5.6-luna.watcher` | 36 | 45 | 9 | 2 | 20.00% | 4.44% | false |
| `cli-proxy/codex.gpt-5.6-terra` | 19 | 27 | 10 | 7 | 37.04% | 25.93% | false |
| `cli-proxy/codex.gpt-5.6-terra.manager` | 42 | 129 | 27 | 21 | 20.93% | 16.28% | false |
| `cli-proxy/dddai.gemini-3.7-flash` | 55 | 65 | 0 | 3 | 0.00% | 4.62% | false |
| `cli-proxy/dddai.gemini-3.7-flash.explorer` | 215 | 241 | 19 | 13 | 7.88% | 5.39% | false |
| `cli-proxy/grok-4.6.implementer` | 31 | 98 | 11 | 19 | 11.22% | 19.39% | false |
| `cli-proxy/grok-4.6.owner` | 22 | 61 | 13 | 6 | 21.31% | 9.84% | false |
| `cli-proxy/grok-4.6.researcher` | 10 | 11 | 1 | 1 | 9.09% | 9.09% | false |
| `cli-proxy/grok-4.6` | 5 | 8 | 0 | 1 | — | — | false |
| `cli-proxy/gpt-5.6-luna` | 71 | 97 | 13 | 14 | 13.40% | 14.43% | false |
| `cli-proxy/gpt-5.6-terra` | 20 | 119 | 17 | 10 | 14.29% | 8.40% | false |
| `cli-proxy/grok-4.6` (large mixed corpus route) | 421 | 707 | 219 | 128 | 30.97% | 18.10% | false,true |
| `cli-proxy/muse-spark-1.2-contributor` | 349 | 410 | 61 | 11 | 14.88% | 2.68% | false,true |
| `google-antigravity/gemini-3.7-flash` | 51 | 51 | 0 | 3 | 0.00% | 5.88% | false |
| `openai-codex/gpt-5.6-luna` | 4 | 27 | 6 | 0 | 22.22% | 0.00% | true |
| `openai-codex/gpt-5.5` | 3 | 5 | 0 | 0 | — | — | false |
| `openai-sub/codex.gpt-5.6-luna` | 116 | 153 | 34 | 14 | 22.22% | 9.15% | false |
| `openai-sub/codex.gpt-5.6-terra` | 2 | 6 | 1 | 1 | 16.67% | 16.67% | false |
| `openai-sub/gpt-official` | 64 | 116 | 20 | 11 | 17.24% | 9.48% | false |
| `xai-sub/xai.grok-4.6` | 81 | 217 | 54 | 22 | 24.88% | 10.14% | false |
| `xai-sub/grok-official` | 28 | 28 | 0 | 2 | 0.00% | 7.14% | false |

Other exact routes with <10 sessions or <30 turns were retained in the extraction but are sparse: DeepSeek variants, GLM variants, Gemini high/vision, Ox-alpha, free OpenCode routes, role routes, and several official/provider aliases. No claim is made for those groups.

## Model-family rollup (session-controlled descriptive view)

Family labels are route-token groupings, not inferred vendor quality labels. The largest adequately sampled families show substantial route/wrapper heterogeneity: Claude routes range from 5.07–14.18% correction and 2.67–18.66% frustration; GPT-5.6 Luna routes range from 13.40–22.22% correction and 9.15–14.78% frustration; GPT-5.6 Terra routes range from 14.29–37.04% correction and 8.40–25.93% frustration; Gemini routes show 0–7.88% correction and 4.62–5.88% frustration; Grok routes show 11.22–30.97% correction and 9.09–19.39% frustration. Because these ranges mix providers, wrappers, roles, and unequal turn/session exposure, they do not support a family ranking.

A session-controlled interpretation is especially important: high-turn sessions contribute many eligible turns, while one-turn agent sessions inflate session counts without equivalent exposure. The exact-route table supplies both denominators; readers should not compare raw episode totals across groups.

## Limitations

- The accessible corpus is a generated-agent transcript archive, not a random sample of production conversations.
- Duplicated transcript copies were deduplicated by session ID, but derived child records can still reflect related work.
- Lexical criteria can miss implicit frustration/corrections and can overcount quoted or meta-level language.
- The parse records the route in `model_change`; missing route/model-change records are excluded rather than assigned.
- Fallback is reported only from the explicit boolean field; mixed `{false,true}` means at least one deduplicated record exposed both states.
- Immediate assistant outcome and repeated failure after correction require turn-level pairing and are intentionally **not claimed** here.
- Sparse groups are descriptive only; no denominator-insufficient rate is interpreted as evidence of better or worse behavior.

**Resolved model:** `cli-proxy/codex.gpt-5.6-luna.explorer`; fallback: false.