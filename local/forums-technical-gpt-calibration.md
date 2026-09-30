# Technical forum evidence: GPT calibration and correction resistance

**Scope and method.** Read-only search of OpenAI Community Discourse, Hacker News, and a directly linked technical blog surfaced through HN. LessWrong search was rate-limited (HTTP 429), so no LessWrong claim is made. Forum anecdotes are evidence of reported behavior, not controlled benchmark evidence. Dates are publication dates shown by each source. Evidence labels: **Strong anecdotal** = reproducible prompt/transcript; **Moderate anecdotal** = concrete user report with examples; **Weak anecdotal** = general impression or product claim.

## Findings

### 1. OpenAI Community: reproducible function-name mutation
- URL: https://community.openai.com/t/consistently-reproducable-request-that-causes-a-hallucinated-mutated-function-name/380465.json
- Date/model: 2023-09-18; GPT-4-0613.
- Evidence: The reporter supplies a complete curl request, tool schemas, system instruction “Only use the functions you have been provided with,” and observed output. The model returned `Set_Assistant_Personality__ChatGPT_Tasks_.assistant` although the declared function was `Set_Assistant_Personality__ChatGPT_Tasks_`; the post calls this “a hallucinated/mutated function name.” The reporter says the suffix persisted after removing personality instructions and the system message, but disappeared when the second function definition was removed.
- Classification: factual/tool hallucination; instruction-following failure. **Strong anecdotal** because the prompt and output are reproducible in the post. It does not establish comparative GPT-family frequency.

### 2. OpenAI Community: fabricated citation, then reaffirmation until forced checking
- URL: https://community.openai.com/t/critical-hallucination-and-false-citation-of-nonexistent-articles-and-fabricated-expert-quotes/1252568.json
- Date/model: 2025-05-05; GPT-4.0, ChatGPT iOS app.
- Evidence: User reports that ChatGPT invented a *Vox* article, “Are We Changing How We Talk to Machines — and Each Other?”, and a quote attributed to “Dr. John Sullivan, linguist at Harvard.” The report states that when asked whether the quote was authentic, ChatGPT “initially reaffirmed its legitimacy”—reversing only after a forced web check showed the source was fabricated.
- Classification: factual hallucination plus correction resistance / failure to concede uncertainty. **Moderate anecdotal**: detailed transcript summary and named artifacts, but the post does not include the full original exchange.

### 3. OpenAI Community: fabricated data and URLs in application workflows
- URL: https://community.openai.com/search.json?q=hallucination (topic links embedded in the returned Discourse results; relevant IDs 949111, 746750, 732256)
- Dates/models: 2024-04-30 through 2024-09-23; reports mention GPT-4o, Assistants API v1/v2, and file-grounded workflows.
- Evidence: Search results quote users reporting “4o invents fake urls,” “complete inventions of data,” and responses about topics absent from supplied files that included “entirely made-up data.” One result (topic 380465 above) provides the strongest reproducible case; these additional entries corroborate recurring reports but are not treated as controlled comparisons.
- Classification: factual hallucination, source/URL fabrication. **Weak-to-moderate anecdotal**: Discourse index blurbs are direct forum text but not full threads here.

### 4. Hacker News: coding hallucination with nonexistent APIs, including after correction
- URL: https://news.ycombinator.com/item?id=35568488
- Date: 2023-04-14.
- Evidence: A user writes ChatGPT “continually seems to just make up answers and confidently display them as correct.” In an AWS Amplify Auth case, it recommended methods that “don’t exist at all”; after correction, it produced more suggestions with methods that did not exist. The same report says ChatGPT conflated React Native Animated with the separate Reanimated project.
- Classification: factual hallucination; domain confusion; correction resistance. **Moderate anecdotal**: concrete APIs and a correction sequence, but no raw prompt/output transcript.
- Counterevidence in the same thread: another commenter says ChatGPT successfully generated most of a generic GitHub REST API Java utility after one or two refinements. This indicates task/domain dependence, not universal failure.

### 5. HN-linked technical case: “doubling down” after a mistaken premise
- URL: https://lukeplant.me.uk/blog/posts/abstract-logic-and-the-doubling-down-bias/
- Date: 2023-05-01; author labels the example GPT-3.5 Turbo.
- Evidence: In a speech-therapy request, ChatGPT claimed “straw,” “sticks,” “huff,” “puff,” and “bricks” contained the /d/ sound. When asked “Where are the D sounds in three little pigs?”, it defended the premise with further incorrect explanations. In a separate session, asked to rate the same claims, it correctly answered that all were wrong and explicitly said none had the /d/ sound. The author describes the first-session behavior as carrying on “producing nonsense to match this hypothetical world.”
- Classification: self-contamination from prior answer; doubling down; failure to self-correct. **Strong anecdotal**: long quoted transcript and a useful same-author contrast session. It is not a controlled model-family comparison.
- Interpretive boundary: The author hypothesizes tension between accepting fictional premises and resisting nonsense; that is a hypothesis, not demonstrated mechanism.

### 6. HN: explicit model comparison, but low-quality anecdote
- URL: https://news.ycombinator.com/item?id=47181648
- Date: 2026-02-27.
- Evidence: The post asks whether the ocean is left or right when driving clockwise around an island and reports: “ChatGPT: Wrong but reasoned itself back to being correct”; Gemini “Correct”; Grok correct with expert mode after 35s; Claude Sonnet 4.6 “Confidently incorrect.” Screenshots are linked at https://imgur.com/a/7pmcoWr.
- Classification: self-correction and model comparison. **Weak anecdotal**: one puzzle, paraphrased outputs, and screenshots rather than a reproducible transcript; also too little information about prompt/context to infer family-level tendencies.

### 7. HN: cross-model product-fact claim
- URL: https://news.ycombinator.com/item?id=47579771
- Date: 2026-03-30.
- Evidence: The author says ChatGPT, Claude, Gemini, and Perplexity “regularly describe SaaS products with specific but incorrect details” including “wrong pricing tiers, deprecated features, misattributed integrations,” “with no uncertainty expressed.” The post says a tool runs consistent buyer-style prompts and shows verbatim output, but the HN record provides no underlying cases or scores.
- Classification: calibration/abstention failure; cross-model comparison. **Weak anecdotal**: claims a consistent test but supplies insufficient primary evidence in the thread.

## Synthesis against the target question
- The strongest forum evidence supports the existence of GPT/ChatGPT failure modes involving factual fabrication, tool/schema mutation, overconfident presentation, and persistence after user challenge. The clearest “failure to concede” evidence is the fabricated-*Vox* report and Luke Plant’s quoted /d/-sound exchange.
- Asking versus assuming: the reports show the models answering when they should have abstained or verified (nonexistent APIs, nonexistent citations, absent file topics). They do not quantify a GPT-specific propensity to ask fewer clarifying questions.
- Comparative claim: available forum anecdotes are mixed and underpowered. One HN anecdote reports ChatGPT wrong then self-correcting while Gemini was correct; another reports all four major assistants producing unsupported SaaS facts. These cannot establish that GPT models are unusually prone relative to Claude, Gemini, or other families.
- Benchmark boundary: none of these forum posts is the AA-Omniscience benchmark. They provide ecological examples and reproducible prompts, but not prevalence estimates, calibrated probabilities, or controlled family comparisons.

## Search limitations
- OpenAI Community Discourse search JSON was accessible and yielded direct topic APIs for selected reports.
- Hacker News Algolia search and item APIs were accessible.
- LessWrong search returned HTTP 429 from the reader; Bing RSS produced no usable result. Therefore this artifact intentionally makes no LessWrong evidence claim.

## Bottom line
**PASS.** Direct URLs, dates, quotes/paraphrases, classifications, and evidence-strength labels are included. Evidence supports “GPT can exhibit confident fabrication and correction resistance in real user reports,” but does **not** support the stronger conclusion that GPT is unusually likely to do so compared with other model families.
