# AA-Omniscience methodology and evidential scope

## Primary sources
- Paper (full text, v1, 17 Nov 2025): https://arxiv.org/html/2511.13029
- Abstract: https://arxiv.org/abs/2511.13029
- Public dataset/card (ArtificialAnalysis/AA-Omniscience-Public): https://huggingface.co/datasets/ArtificialAnalysis/AA-Omniscience-Public
- Public runner documentation (unofficial, but useful for pinned public split details): https://github.com/stzoozz/aa-omniscience-codex-harness
- Leaderboard link named by the dataset card: https://artificialanalysis.ai/evaluations/omniscience

## What is measured
AA-Omniscience evaluates unaided, short-form factual recall plus whether a model abstains when uncertain. The full set has 6,000 questions spanning 42 topics in six domains: Business; Humanities & Social Sciences; Health; Law; Software Engineering; and Science, Engineering & Mathematics. Questions are intended to be difficult, unambiguous, source-independent (except where detailed legal text is intrinsic), and precise. Models receive no context or tools. The answer prompt explicitly says to answer only when confident and that admitting lack of knowledge is preferable to a wrong answer (paper §2.3; dataset card “Answering and scoring approach”).

## Metrics and abstention treatment
Each response is graded into four mutually exclusive classes: correct (c), partially correct (p), incorrect (i), or not attempted/abstained (a). The paper defines:

- **Omniscience Index (OI)** = `100 * (c - i) / (c + p + i + a)`, bounded [-100,100]. Partial answers enter the denominator but neither numerator term.
- **Accuracy** = `c / (c + p + i + a)`; thus abstentions count in the denominator and do not earn credit.
- **Hallucination rate** = `i / (p + i + a)`, i.e. incorrect answers among non-fully-correct outcomes (the paper describes this as the tendency to be wrong when the model does not get the answer right).
- Attempt rate is the complement of abstention: `(c+p+i)/(c+p+i+a)`.

OI rewards a correct answer +1, penalizes an incorrect answer -1, and gives abstention 0 (scaled by 100). OI=0 means correct and incorrect counts are equal; an all-abstain model also scores 0. The authors explicitly identify this as a limitation: all-abstain would rank fourth among the 36 models tested. The lowest observed attempt rate was 42%; the next lowest was 65%; the highest refusal rate was 58%. These facts constrain interpretation: OI is intentionally conservative about guessing, but can be gamed by refusal in principle. The authors suggest a future -0.5 wrong-answer penalty as one alternative.

## Grading
A grading model classifies each answer using the four-way rubric. The launch paper used **Gemini 2.5 Flash Preview (09-2025), with reasoning**, selected because it aligned better with manual human grading than gpt-oss-120b, Qwen3-235B-A22B-Thinking, and GPT-5. The rubric treats an equivalent answer as correct, permits omission of information inferable from the question, tolerates clear name typos, requires numerical answers to the last significant figure, and distinguishes incomplete answers (partial) from contradictions (incorrect). Explicit uncertainty/refusal is NOT_ATTEMPTED even if it mentions plausible candidates. The full rubric and examples are reproduced in the dataset card.

The authors report a single pass over the full set; ten repeated runs on a sample of models had OI standard deviation below 0.005. This is evidence of run-level stability for that sample, not a guarantee for every model/API configuration.

## Question generation and data provenance
Questions are generated, filtered, and revised by an automated agent using authoritative first-party or well-recognized sources. Selection favors current, economically relevant topics and an estimated “first answerable date”; fewer than 2% were first answerable in 2025. The generation pipeline filters for similarity, difficulty, ambiguity, and source-text dependence, and tests questions against many frontier models to avoid saturation. A major limitation is model dependence: generation/filtering/revision all used OpenAI GPT-5, potentially favoring GPT-5-family wording or answerability. The paper proposes multi-model generation in future work.

## Public dataset
Only 10% is public: **600 questions**, sampled to match full-set domain/category distributions and performance at release. It is suitable for an indication of overall OI, accuracy, and hallucination rate. The paper and card explicitly say domain/topic-level results on the public split are not reliable because n is too small. The public card is Apache-2.0. The unofficial runner records the pinned HF revision `4a8ffc87c4650054825fb767fe0da4a4fc97ff32` and CSV `AA-Omniscience_dataset_public.csv`; treat those as runner-specific reproducibility details, not official leaderboard methodology.

## Model-specific launch results (primary paper)
The paper’s abstract reports **Claude 4.1 Opus OI = 4.8**, highest, and says only three of 36 tested models scored above zero. In §3.1 it reports:

- **Grok 4:** 39% accuracy, 64% hallucination rate.
- **GPT-5 (high):** 39% accuracy, 81% hallucination rate.
- **Claude 4.1 Opus:** 36% accuracy and one of the lowest hallucination rates, producing OI 4.8.
- **Claude 4.5 Haiku:** 16% accuracy, 26% hallucination rate; higher OI than GPT-5 (high) and Kimi K2 Thinking according to §3.5.
- **Llama 3.1 405B:** described as high OI despite weaker general-capability scores; lower knowledge/higher-reliability quadrant.
- **gpt-oss-120b (high):** elevated hallucination and poor OI despite strong general Intelligence Index.
- **GPT-5 (minimal)** and **Gemini 2.5 Flash (2025-09):** top-ten accuracy but high hallucination, illustrating why accuracy alone misleads.
- **Minimax M2** and **Kimi K2 Thinking:** strong general capability but poor OI due to hallucination (qualitative comparison in §3.2).

Domain leaders are explicitly reported: Claude 4.1 Opus leads Law, Software Engineering, and Humanities & Social Sciences; GPT-5.1 leads Business; Grok 4 leads Health and Science/Engineering/Mathematics. Grok 4 Fast is seventh in Science/Engineering/Mathematics despite sixteenth overall. The paper does not provide a complete numeric table in the HTML text; do not infer missing per-family scores from the chart images.

## What this can and cannot support about Jamie’s hypothesis
**Supported, with important qualification:** AA-Omniscience directly tests factual errors, abstention/calibration, and the behavioral cost of guessing. Its launch results show GPT-5 (high) at the same 39% accuracy as Grok 4 but a much higher hallucination rate (81% vs 64%), while Claude 4.1 Opus has lower accuracy (36%) but better calibration and the best OI. GPT-5 (minimal) and Gemini 2.5 Flash are explicitly cited as high-accuracy/high-hallucination cases. This supports the narrower claim that some GPT configurations can be unusually prone to confident wrong answers relative to peers on this task, and that raw accuracy obscures this.

**Not directly tested:** The benchmark does not measure defending a mistaken interpretation, conversational argument, willingness to concede after correction, sycophancy, scope/instruction-following errors, self-correction across turns, or deference to peer models. It is single-question, single-pass, no-context QA with a “just answer” instruction. Therefore it cannot establish that GPT models generally confabulate more, defend errors more, or resist uncertainty more across dialogue. “Calibration” here means abstention/guessing behavior under this prompt, not a full probabilistic calibration curve.

**External-validity limits:** English-only questions and predominantly US/UK/English-speaking sources limit geographic/language generalization. GPT-5-generated questions may introduce family-specific wording bias. The public 600-question split cannot support fine-grained domain claims. Results are a November 2025 launch snapshot; current leaderboard values may change as Artificial Analysis updates evaluations. Forum anecdotes should be treated as qualitative corroboration only, never as benchmark evidence.

## Bottom line
AA-Omniscience is strong evidence for comparing factual reliability and abstention under controlled, tool-free short-answer conditions. It is evidence against interpreting GPT’s high accuracy as reliable knowledge, and its reported GPT-5-vs-Grok/Claude figures are relevant to Jamie’s observation. It is not a test of interpersonal or multi-turn epistemic behavior, so a conclusion that GPT is broadly more defensive, sycophantic, or unwilling to concede would require separate dialogue experiments.
