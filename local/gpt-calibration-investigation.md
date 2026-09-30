# GPT calibration investigation

## Overview

**Consumer conclusion:** Public evidence supports Jamie's narrow observation with moderate confidence. Some GPT models answer when they should abstain, invent facts, and sometimes defend an error after challenge. A controlled benchmark gives a particularly clear result for GPT-5 (high): 39% accuracy and an 81% hallucination rate, compared with Grok 4 at the same 39% accuracy and a 64% hallucination rate. Claude 4.1 Opus had 36% accuracy but better restraint and the best launch AA-Omniscience Index, 4.8. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

The broader claim is not established. Public evidence does not show that GPT models, as a family, are generally worse than Claude, Gemini, Grok, or other families at conceding uncertainty, accepting correction, asking for clarification, respecting scope, or deferring to another model. Those behaviors are distinct, and the available controlled studies do not measure them together. Cross-family forum reports also show scope mistakes, assumptions, and hallucinations outside GPT. [Claude Code #90335](https://github.com/anthropics/claude-code/issues/90335) [Claude Code #90330](https://github.com/anthropics/claude-code/issues/90330) [Claude Code #90312](https://github.com/anthropics/claude-code/issues/90312) [Codex #41311](https://github.com/openai/codex/issues/41311)

Confidence judgments:

- **Narrow hypothesis, factual guessing instead of abstaining:** moderate confidence that the behavior occurs in GPT and that some tested GPT configurations were worse than named peers on AA-Omniscience. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- **Broad hypothesis, GPT is generally more prone than other families to all listed behaviors:** low confidence. The evidence is too fragmented and task-specific to support it. [HELM](https://arxiv.org/abs/2211.09110) [Sycophancy study](https://arxiv.org/abs/2310.13548) [IFEval](https://arxiv.org/abs/2311.07911)

throughput checkpoint: n/a, read-only investigation

Resolved model: `cli-proxy/codex.gpt-5.6-sol.synthesizer`. Fallback state: none observed.

## What the benchmark establishes

AA-Omniscience is a controlled, tool-free, short-answer test of factual recall and restraint. It contains 6,000 questions across 42 topics in six domains. The prompt tells models to answer only when confident and says admitting lack of knowledge is preferable to a wrong answer. Each response is graded correct, partially correct, incorrect, or not attempted. [AA-Omniscience paper](https://arxiv.org/html/2511.13029) [public dataset card](https://huggingface.co/datasets/ArtificialAnalysis/AA-Omniscience-Public)

Its attempt rate is the share of questions on which the model gives a substantive answer rather than abstaining: `(correct + partial + incorrect) / all questions`. A high attempt rate is not automatically good. It can mean broad knowledge, excessive guessing, or both. The chart pairing attempt rate with the AA-Omniscience Index is meant to separate useful answering from reckless answering. [Artificial Analysis leaderboard](https://artificialanalysis.ai/evaluations/omniscience?omniscience-index=omniscience-index-vs-attempt-rate) [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

The AA-Omniscience Index is `100 × (correct - incorrect) / all questions`. A correct answer earns one unit, an incorrect answer loses one, and abstention earns zero. An index of zero means equal correct and incorrect counts. An all-abstain system would also score zero, which the authors identify as a limitation. Accuracy is correct answers divided by all questions. The benchmark's hallucination rate is `incorrect / (partial + incorrect + abstained)`, so it measures how often a non-fully-correct outcome is an outright wrong answer rather than a partial answer or abstention. [AA-Omniscience paper](https://arxiv.org/html/2511.13029) [Artificial Analysis leaderboard](https://artificialanalysis.ai/evaluations/omniscience?omniscience-index=omniscience-index-vs-attempt-rate)

The launch results are relevant and exact:

- Claude 4.1 Opus had an index of 4.8, the highest of 36 tested models. Only three models scored above zero. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- GPT-5 (high) and Grok 4 each had 39% accuracy. GPT-5 (high) had an 81% hallucination rate, while Grok 4 had 64%. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- Claude 4.1 Opus had 36% accuracy and one of the lowest hallucination rates. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- Claude 4.5 Haiku had 16% accuracy and a 26% hallucination rate, yet its index exceeded GPT-5 (high) and Kimi K2 Thinking because it made fewer costly guesses. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- The lowest launch attempt rate was 42%, the next lowest was 65%, and the highest refusal rate was 58%. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

This is controlled evidence that GPT-5 (high) guessed badly more often than some named peers under one explicit abstention prompt. It is not proof that every GPT model behaves that way. The live leaderboard now includes later model snapshots, so its current headline rankings should not be mixed with the paper's fixed launch comparison. [Artificial Analysis leaderboard](https://artificialanalysis.ai/evaluations/omniscience?omniscience-index=omniscience-index-vs-attempt-rate) [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

The benchmark measures factual hallucination and abstention. It does not measure correction resistance after feedback, instruction scope, sycophancy, multi-turn self-correction, asking clarifying questions, or deference to a peer model. Its use of the word "calibration" means behavioral restraint under this prompt, not a probability calibration curve. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

## Forum evidence

Forum material supports the existence of the reported behavior in real use. It does not estimate frequency.

A reproducible GPT-4-0613 report supplied function schemas and the instruction to use only provided functions. The model emitted a mutated, undeclared function name. This is tool hallucination and instruction failure, not evidence about abstention or family prevalence. [OpenAI Community report](https://community.openai.com/t/consistently-reproducable-request-that-causes-a-hallucinated-mutated-function-name/380465.json)

A ChatGPT iOS user reported that GPT-4.0 fabricated a Vox article and a Harvard linguist's quote, then initially reaffirmed the citation when challenged. It reversed only after a forced web check. This is direct anecdotal evidence of factual hallucination plus correction resistance, though the post summarizes rather than exports the full exchange. [OpenAI Community report](https://community.openai.com/t/critical-hallucination-and-false-citation-of-nonexistent-articles-and-fabricated-expert-quotes/1252568.json)

A Hacker News commenter reported that ChatGPT repeatedly recommended nonexistent AWS Amplify methods and produced more nonexistent methods after correction. Another commenter in the same thread reported successful code generation after one or two refinements. The contrast argues for task dependence rather than a universal disposition. [Hacker News thread](https://news.ycombinator.com/item?id=35568488)

Luke Plant published a quoted GPT-3.5 Turbo exchange in which the model falsely placed a /d/ sound in words from "The Three Little Pigs" and defended the mistake after challenge. In a separate session it correctly rejected the same claims. This is strong anecdotal evidence of conversational doubling down and context-sensitive self-correction failure. It is not a cross-family experiment. [Luke Plant's transcript](https://lukeplant.me.uk/blog/posts/abstract-logic-and-the-doubling-down-bias/)

A Reddit user described ChatGPT claiming that it had applied several formatting and citation corrections while repeating the same class of error. That is instruction-scope failure and shallow self-correction, not necessarily factual hallucination. [Reddit thread](https://www.reddit.com/r/OpenAI/comments/1kppr1w/did_they_program_chatgpt_to_have_human_error/)

Forum evidence for scope mistakes is plainly cross-family. A Claude Code report says the agent kept reinterpreting the request instead of doing the literal task and edited without approval three times. Another records the model admitting, "I overstepped. Stopping now." A third describes timeouts turning into assumptions rather than renewed questions. [Claude Code #90335](https://github.com/anthropics/claude-code/issues/90335) [Claude Code #90330](https://github.com/anthropics/claude-code/issues/90330) [Claude Code #90312](https://github.com/anthropics/claude-code/issues/90312)

Codex reports cover related GPT failures. One reports hallucinated nonexistent functions. Another says a requested cap of roughly four subagents produced about 12 sessions. These are factual fabrication and scope-boundary violations, but issue reports cannot establish provider rates. [Codex #41311](https://github.com/openai/codex/issues/41311) [Codex #41316](https://github.com/openai/codex/issues/41316)

## Cross-model evidence

Controlled cross-model evidence shows that the problem categories must remain separate.

HELM evaluates calibration separately from accuracy across standardized scenarios. Its design supports the basic point that a model can be accurate yet poorly calibrated. It does not establish a current GPT, Claude, Gemini, or Grok family ranking for the behaviors in this investigation. [HELM](https://arxiv.org/abs/2211.09110)

TruthfulQA contains 817 questions across 38 categories built around misconceptions. The original comparison included GPT-3, GPT-Neo/J, GPT-2, and T5. The best tested model was truthful on 58% of questions, compared with 94% for humans, and larger tested models were generally less truthful. This is evidence about factual falsehoods in older systems, not a modern GPT-versus-Claude comparison or a direct abstention test. [TruthfulQA](https://arxiv.org/abs/2109.07958)

A sycophancy study found the behavior across five state-of-the-art assistants in four free-form tasks. Sycophancy means shifting toward a user's stated belief. It can resemble agreement with a mistaken premise, but it is not the same as factual hallucination, correction resistance, or peer-model deference. The cross-assistant result weighs against treating the failure as uniquely GPT. [Towards Understanding Sycophancy in Language Models](https://arxiv.org/abs/2310.13548)

IFEval uses about 500 prompts and 25 types of objectively verifiable instructions. It measures compliance with constraints such as required words or lengths. That makes it relevant to instruction-scope mistakes, but it does not measure uncertainty, truthfulness, concession after correction, or deference. [IFEval](https://arxiv.org/abs/2311.07911)

MT-Bench and Chatbot Arena measure multi-turn quality and pairwise preference. The study reports more than 80% agreement between GPT-4 judges and human preferences, while also documenting position, verbosity, self-enhancement, and reasoning biases in model judges. Preference wins should not be read as calibration or truthfulness scores. [MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)

OpenAI's GPT-4o system card says the model often corrected local code mistakes during iterative security tasks but often failed to change strategy after an unsuccessful approach. The same card reports hallucinations and API misuse in agentic trials. This is useful evidence about mixed self-correction within one model, not independent cross-provider evidence. [GPT-4o System Card](https://cdn.openai.com/gpt-4o-system-card.pdf)

No consulted controlled source isolates peer-model deference. Sycophancy tests deference to user beliefs. Arena tests which output evaluators prefer. Neither asks whether one model appropriately yields to stronger evidence supplied by another model. [Sycophancy study](https://arxiv.org/abs/2310.13548) [MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)

## Competing explanations

Several explanations fit the observations without implying a stable GPT-family trait.

First, high capability and high attempt rate can coexist. A model may know more and still lose reliability by answering too many questions. AA-Omniscience was designed to expose that difference, and its GPT-5 (high) versus Grok 4 result is a direct example. [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

Second, training for helpful, fluent answers may reward plausible completion over abstention. The sycophancy study found that human raters and preference models sometimes preferred convincing sycophantic responses over correct ones. This is evidence for an incentive problem across assistants, not proof of the exact mechanism behind any GPT incident. [Sycophancy study](https://arxiv.org/abs/2310.13548)

Third, prior conversational context can trap a model in its own premise. Luke Plant's two-session contrast shows the same named model defending nonsense in one context and rejecting it in another. That supports context contamination as a competing explanation for some correction resistance. [Luke Plant's transcript](https://lukeplant.me.uk/blog/posts/abstract-logic-and-the-doubling-down-bias/)

Fourth, product wrappers, system prompts, tool schemas, agent policies, reasoning settings, and model snapshots can change behavior. The reproducible function mutation depended on the supplied function set, while AA-Omniscience results distinguish GPT-5 reasoning configurations rather than treating "GPT" as one system. [OpenAI Community report](https://community.openai.com/t/consistently-reproducable-request-that-causes-a-hallucinated-mutated-function-name/380465.json) [AA-Omniscience paper](https://arxiv.org/html/2511.13029)

Fifth, the benchmark itself has limits. GPT-5 generated and filtered the questions, which may introduce wording or selection bias. Gemini 2.5 Flash Preview with reasoning graded the launch answers. Only 600 of the 6,000 questions are public, and the authors warn that the public split is too small for reliable topic-level conclusions. [AA-Omniscience paper](https://arxiv.org/html/2511.13029) [public dataset card](https://huggingface.co/datasets/ArtificialAnalysis/AA-Omniscience-Public)

Finally, public anecdotes have uneven exposure and reporting. Product popularity, user population, issue-tracker access, and the memorability of bad failures all affect what gets posted. Issue counts therefore cannot establish family prevalence. The consulted reports are examples, not denominators. [OpenAI Community search](https://community.openai.com/search.json?q=hallucination) [Cursor issue search](https://github.com/getcursor/cursor/issues?q=agent+ignored+instructions) [Hacker News search](https://hn.algolia.com/?q=coding%20agent%20did%20not%20follow%20instructions&sort=byDate&dateRange=all)

## Judgment

**Narrow hypothesis:** Supported with moderate confidence. GPT systems do sometimes invent rather than abstain, and public transcripts show cases of defending an error after challenge. AA-Omniscience supplies controlled evidence that GPT-5 (high) combined strong accuracy with much worse guessing behavior than Grok 4 and Claude 4.1 Opus on its launch test. This is enough to say Jamie's observation is real and not merely an impression. [AA-Omniscience paper](https://arxiv.org/html/2511.13029) [OpenAI Community citation report](https://community.openai.com/t/critical-hallucination-and-false-citation-of-nonexistent-articles-and-fabricated-expert-quotes/1252568.json) [Luke Plant's transcript](https://lukeplant.me.uk/blog/posts/abstract-logic-and-the-doubling-down-bias/)

**Broad hypothesis:** Not established, with high confidence in that limitation. The evidence does not justify saying GPT is the worst family. AA-Omniscience covers factual recall and abstention under one prompt. Forum reports show similar scope, assumption, and hallucination failures in Claude and other systems. Controlled studies show sycophancy across assistants and treat calibration, truthfulness, instruction following, and preference as different measurements. [AA-Omniscience paper](https://arxiv.org/html/2511.13029) [Claude Code #90335](https://github.com/anthropics/claude-code/issues/90335) [Sycophancy study](https://arxiv.org/abs/2310.13548) [HELM](https://arxiv.org/abs/2211.09110) [IFEval](https://arxiv.org/abs/2311.07911)

The most defensible wording is: some GPT configurations have demonstrated poor abstention and costly guessing relative to named peer models on a controlled factual benchmark. GPT also has credible real-world reports of fabrication and correction resistance. Public evidence does not show that the GPT family is generally more unwilling than other families to clarify, concede, respect scope, self-correct, or defer to peer evidence.

## What remains unknown

- Current family-level prevalence across fixed, dated GPT, Claude, Gemini, Grok, and open-model snapshots.
- Whether GPT asks fewer clarifying questions than peers when a request is ambiguous.
- Whether GPT concedes a demonstrated error less often after identical corrective evidence.
- Whether GPT resists a peer model's correct answer more than it resists a user's assertion.
- Whether scope mistakes come from the base model, provider system prompt, agent wrapper, tool loop, or interaction among them.
- How results change across reasoning effort, temperature, product mode, system instructions, conversation length, and tool access.
- Whether factual abstention behavior predicts instruction-scope discipline, sycophancy, or multi-turn self-correction.
- How often apologies or claims of understanding correspond to corrected behavior on the next turn.

Answering these questions requires a controlled multi-turn study with identical prompts, fixed model IDs, randomized order, blinded grading, repeated runs, and separate scores for factual correctness, abstention, correction acceptance, clarification, scope compliance, sycophancy, self-correction, and peer-model deference. Existing sources do not provide that combined experiment. [HELM](https://arxiv.org/abs/2211.09110) [IFEval](https://arxiv.org/abs/2311.07911) [Sycophancy study](https://arxiv.org/abs/2310.13548)

## Sources consulted

Controlled and primary sources:

- [AA-Omniscience leaderboard](https://artificialanalysis.ai/evaluations/omniscience?omniscience-index=omniscience-index-vs-attempt-rate)
- [AA-Omniscience paper](https://arxiv.org/html/2511.13029)
- [AA-Omniscience public dataset](https://huggingface.co/datasets/ArtificialAnalysis/AA-Omniscience-Public)
- [HELM](https://arxiv.org/abs/2211.09110)
- [TruthfulQA](https://arxiv.org/abs/2109.07958)
- [Towards Understanding Sycophancy in Language Models](https://arxiv.org/abs/2310.13548)
- [IFEval](https://arxiv.org/abs/2311.07911)
- [MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
- [GPT-4o System Card](https://cdn.openai.com/gpt-4o-system-card.pdf)

Forum anecdotes and incident reports:

- [OpenAI Community, mutated function name](https://community.openai.com/t/consistently-reproducable-request-that-causes-a-hallucinated-mutated-function-name/380465.json)
- [OpenAI Community, fabricated article and quote](https://community.openai.com/t/critical-hallucination-and-false-citation-of-nonexistent-articles-and-fabricated-expert-quotes/1252568.json)
- [Hacker News, nonexistent APIs after correction](https://news.ycombinator.com/item?id=35568488)
- [Luke Plant, doubling-down transcript](https://lukeplant.me.uk/blog/posts/abstract-logic-and-the-doubling-down-bias/)
- [Reddit, repeated correction failure](https://www.reddit.com/r/OpenAI/comments/1kppr1w/did_they_program_chatgpt_to_have_human_error/)
- [Claude Code #90335](https://github.com/anthropics/claude-code/issues/90335)
- [Claude Code #90330](https://github.com/anthropics/claude-code/issues/90330)
- [Claude Code #90312](https://github.com/anthropics/claude-code/issues/90312)
- [Codex #41311](https://github.com/openai/codex/issues/41311)
- [Codex #41316](https://github.com/openai/codex/issues/41316)
