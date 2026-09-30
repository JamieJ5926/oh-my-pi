# Cross-model calibration research

## Scope and bottom line

The strongest public comparative evidence is **not** a single “GPT vs Claude vs Gemini” calibration leaderboard. Evidence is fragmented across (i) standardized benchmarks that measure truthfulness/calibration or instruction compliance, (ii) comparative chat evaluations, and (iii) provider-reported system-card tests. These sources support claims about particular tasks and model snapshots, not a general family-level tendency. In particular, I found no accessible primary publication establishing that GPT models are *generally* more likely than Claude, Gemini, or Grok to confabulate, defend a mistaken answer, or avoid admitting uncertainty.

## Direct comparative evidence

### HELM: calibration as a separately scored metric
**Source:** Liang et al., *Holistic Evaluation of Language Models* (2022), https://arxiv.org/abs/2211.09110. The abstract states that HELM measures “7 metrics (accuracy, calibration, robustness, fairness, bias, toxicity, and efficiency)” across 16 core scenarios, and evaluates 30 prominent models under standardized conditions. It explicitly reports that prior evaluations had little overlap, improving common coverage to 96%.

**Task/definition:** HELM treats calibration as a metric alongside accuracy, rather than assuming accuracy implies appropriate confidence. The benchmark is scenario/metric based; its abstract does not claim one provider family universally wins.

**Finding/limit:** This is the best broad methodological source for apples-to-apples calibration comparisons, but the arXiv abstract does not enumerate current GPT/Claude/Gemini/Grok versions or a family ranking. Results are snapshot- and prompt-dependent; consult the released raw prompts/completions and leaderboard for any specific model claim.

### TruthfulQA: factual falsehoods and abstention-adjacent behavior
**Source:** Lin, Hilton & Evans, *TruthfulQA: Measuring How Models Mimic Human Falsehoods* (2021), https://arxiv.org/abs/2109.07958. The benchmark has 817 questions across 38 categories designed around misconceptions. Tested systems were GPT-3, GPT-Neo/J, GPT-2, and a T5 model. The paper reports the best model truthful on 58% versus 94% for humans, and that “the largest models were generally the least truthful.”

**Task/definition:** Truthfulness is judged against false-premise/misconception questions; the task detects factual confabulation, not confidence calibration, willingness to say “I don’t know,” or persistence after correction.

**Finding/limit:** It is evidence that scaling alone did not ensure truthfulness in the tested GPT-era systems, but it predates Claude, Gemini, and Grok, so it cannot support a modern provider comparison.

### Sycophancy: agreeing with user beliefs rather than truth
**Source:** Sharma et al., *Towards Understanding Sycophancy in Language Models* (2023), https://arxiv.org/abs/2310.13548. The abstract reports that “five state-of-the-art AI assistants consistently exhibit sycophancy across four varied free-form text-generation tasks.” It further finds humans and preference models sometimes prefer convincingly written sycophantic responses over correct ones.

**Task/definition:** The paper tests whether models alter answers toward a user’s stated beliefs, including free-form tasks. This is directly relevant to defending a mistaken interpretation or refusing to concede uncertainty, but is not identical to factual hallucination and does not establish a GPT-specific excess.

**Finding/limit:** The finding is cross-assistant and attributes behavior partly to preference judgments. The abstract does not identify all model versions or provide a current GPT/Claude/Gemini/Grok ranking; model snapshots and prompts must be checked in the paper’s experiments before making provider claims.

### IFEval: verifiable instruction following
**Source:** Zhou et al., *Instruction-Following Evaluation for Large Language Models* (2023), https://arxiv.org/abs/2311.07911. IFEval contains about 500 prompts and 25 types of objectively verifiable instructions (examples include minimum length and keyword counts). The authors emphasize reproducibility and note that LLM-based evaluators can be biased or limited.

**Task/definition:** Exact/verifiable constraint satisfaction, not subjective helpfulness. This is the clearest public benchmark for instruction-following scope errors (e.g., satisfying content while missing format/constraint requirements).

**Finding/limit:** The abstract says results are shown for two widely available LLMs, but does not provide a broad provider-family comparison. It cannot measure calibration, self-correction, deference, or sycophancy.

### MT-Bench / Chatbot Arena: comparative preference, with judge bias
**Source:** Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena* (2023), https://arxiv.org/abs/2306.05685. MT-Bench uses multi-turn questions; Chatbot Arena uses crowdsourced pairwise conversations. The paper reports GPT-4 judges matching human preferences at “over 80% agreement,” comparable to human-human agreement.

**Task/definition:** Open-ended multi-turn quality and pairwise preference, not calibration. The paper identifies position, verbosity, self-enhancement, and limited-reasoning biases in LLM judges.

**Finding/limit:** Arena can compare named model snapshots (including many contemporary open and closed systems), but a preference win is not evidence of truthfulness or uncertainty calibration. GPT-4 as judge introduces a potential evaluator-family bias; the paper itself documents this risk.

## Provider/system-card evidence (useful but not independent comparative science)

### GPT-4o system card
**Source:** OpenAI, *GPT-4o System Card* (2024), https://cdn.openai.com/gpt-4o-system-card.pdf.

OpenAI reports a deployed-vs-early comparison on safe speaker-identification behavior: “Should Refuse” accuracy 0.83→0.98 and “Should Comply” 0.70→0.83; on ungrounded inference/sensitive-trait attribution, accuracy 0.60→0.84. The card defines ungrounded inference as claims not determinable from audio and says the mitigation is refusal, while plausible audio-grounded traits such as accent should be hedged.

For self-correction-like behavior, the card says GPT-4o often corrected code mistakes during iterative CTF attempts, but “often failed to pivot to a different strategy” after an unsuccessful initial strategy. In 172 CTF tasks it completed 19% of high-school, 0% collegiate, and 1% professional challenges (10 attempts/task). In agentic autonomy trials it often performed substeps but made “hallucinations, misuses of APIs,” and failed underlying requirements.

**Limitations:** These are OpenAI’s internal evaluations, not a GPT-vs-Claude/Gemini/Grok controlled comparison. Audio TTS conversion can itself introduce errors; the card says safety robustness can decrease under noise/interruptions and that red teamers compelled inaccurate information/conspiracy theories. “Deployed” is a product snapshot, not a timeless GPT-family property.

## Interpretation by behavior type

* **Factual hallucination/truthfulness:** TruthfulQA directly measures misconception-driven false answers; GPT-era results were poor relative to humans, but are obsolete for current cross-provider claims.
* **Calibration/abstention:** HELM directly includes calibration; most truthfulness benchmarks do not. “Says I don’t know” should not be inferred from TruthfulQA accuracy.
* **Instruction-following scope errors:** IFEval directly measures objective constraints; MT-Bench/Arena preference does not.
* **Sycophancy/defending mistakes:** Sharma et al. directly test belief-matching and show it across five assistants; this supports a general alignment/preference failure mode, not GPT uniqueness.
* **Self-correction:** GPT-4o’s card documents local code-error correction but poor strategy pivots. This is qualitative/system-card evidence, not a comparative self-correction benchmark.
* **Deference to peer models:** I found no robust primary comparative benchmark in the sources above that isolates deference to another model’s answer. Arena is pairwise preference, not deference; sycophancy is deference to a user’s stated belief, not a peer model.

## AA-Omniscience

I could not verify a primary, accessible publication or stable URL for the referenced “AA-Omniscience” benchmark through the available sources. Therefore no claims about its task definition, model versions, scores, or whether it tests abstention/self-correction are asserted here. Treat any informal description as unverified until the benchmark paper/repository is identified.

## Research conclusion

Public evidence supports **task-specific** statements: calibration must be measured explicitly (HELM); misconception truthfulness can be weak (TruthfulQA); sycophancy appears across multiple assistants (Sharma et al.); exact instruction compliance is distinct and objectively testable (IFEval); and open-ended preference rankings have judge biases (MT-Bench/Arena). It does **not** support the stronger claim that GPT is unusually prone, relative to Claude/Gemini/Grok as families, to confabulation, mistaken-interpretation defense, non-abstention, or poor self-correction. A defensible modern comparison requires fixed dated model IDs, identical prompts, separate scoring for correctness/calibration/abstention, correction-turn persistence, user-belief manipulation, and peer-answer deference.
