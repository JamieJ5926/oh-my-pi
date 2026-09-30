/skill:poteto-mode

# Frank POC, first session

## What frank is
A self-building bridge adapter harness on top of the OMP universal execution bridge. Frank assembles harness adapters from hotswappable parts. For the first POC the parts come from jcode. The loop for each part is: find the part you like, isolate it, stand up a self-bridge test around it, then implement it behind the runtime contract.

## Grounding, read before designing
- `handoff-2026-08-31.md` in the repo root. The bridge investigation summary, edit points, and open questions.
- `local://bridge-findings.md` and `agent://BridgeExplainer` from the 2026-08-31 session, if reachable. Consolidated explorer findings and the full architecture explanation.
- The bridge tree is `packages/coding-agent/src/bridge/`, currently untracked.

## Facts that shape the design
- The runtime seam is backend-neutral. Coordinator and executor never branch on pi or jcode.
- A new backend is `bridge/backends/<name>/{backend,protocol,runtime,index}.ts` plus small union edits in `config/settings-schema.ts`, `task/executor.ts`, `task/index.ts`, and the `bridge/index.ts` re-export.
- Irreducibly per harness, no abstraction removes it: wire protocol, process spawn and readiness detection, event extraction, model attribution, transport recovery, host-tool callbacks.
- The runtime coordinator provides admission, bounded event buffering, UTF-8 truncation, cancellation, telemetry. It provides no retries, no transport recovery.
- Registry asymmetry: pi uses a fallback registry, jcode requires a caller-scoped registry from `#ensureJcodeFactory`. Frank must pick one regime and say why.
- `bridge/runtime/contracts.ts` is the seam both live backends implement. Whether it is the single canonical adapter contract stays open until the `core/backend.ts` reconciliation settles. Do not build a second abstraction either way.

## Prerequisites, in order
1. Reconcile the duplicate generic API, gated by `skill://blast-radius`. Audit `bridge/core/backend.ts` and its re-exports from `bridge/core/index.ts` and `bridge/index.ts`. Remove the adapter contracts only if unreferenced, and count the removal as settled only after a package-wide typecheck plus the bridge-core-contracts, agent-registry, agent-lifecycle, persisted-revive, and hub/irc tests pass. Deletion is a hypothesis until that validation. If references surface, keep the contracts and report what uses them.
2. The RAM and wall-time comparison of jcode vs OMP native, from the 2026-08-31 prototype session. Read its numbers if present, they tell you what jcode parts actually cost.

## POC scope, one part end to end
Pick one jcode part worth hotswapping. Candidate examples: the OMP Agents HUD table reading OMP session JSONL from the jcode window, or the jcode-side progress event extraction. Isolate it, wrap it in a self-bridge test that runs it against `runtime/contracts.ts` without the rest of jcode, then implement it as a hotswappable frank part. One part proven through the full loop beats three parts half done.

## Forbidden
- No second generic adapter abstraction beside the runtime contract.
- No git mutations without Jamie's explicit authorization for that exact operation.
- Never run `omp update`.
- No blanket-diff of `v18.0.8..HEAD`. Patch building follows the handoff advisory if needed.
- No scope growth into a third real backend. Frank POC is parts extraction, not a new harness adapter for claude-code, codex, or cursor-agent.

## Acceptance
- One jcode-derived part runs through a self-bridge test on the runtime contract, isolated from the rest of jcode.
- The hotswap point is named in code, not prose: the interface the part implements and the registry or factory slot it plugs into.
- The find-isolate-test-implement loop is written down once, concretely, so the next part is mechanical.
- Typecheck passes. The touched test suites pass.
