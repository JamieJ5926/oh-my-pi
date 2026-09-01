# OMP bridge decision

Date: 2026-08-29
Status: proposed, pending implementation evidence

The standalone core, runtime, Pi, and JCode lanes produced focused evidence, but the bridge is not accepted. Integration is absent, the transport source is parse-corrupt, and the process-global revival factory remains. This record stays proposed.

## Context

OMP currently addresses agents through process-global `IrcBus` and `AgentRegistry` state. That identity model does not provide a durable namespace for concurrent processes, reconnects, or generations. The existing SDK documentation also records that the default process-global registry admits only one `"Main"` identity per generation (`docs/sdk.md`, lines 97-99).

The bridge must cross two different boundaries, and widening IRC IDs does not solve either one:

1. **Session seam.** Replace process-global addressing with a broker-backed session directory. A `SessionAddress` identifies namespace, host or process, backend, session ID, and generation. A versioned `MessageEnvelope` carries message identity, sender and destination, correlation, kind, payload or artifact reference, sequence, timestamp, idempotency, and delivery state. The transport owns serialization, reconnect, acknowledgement, retry, deduplication, and persistence.
2. **Execution seam.** Run Pi and JCode through structured protocol adapters. The adapter owns spawn or attach, structured input, event streaming, cancellation, terminal results, resume or revive, model attribution, and telemetry. Terminal read/write scraping and raw PTY bytes are not protocol contracts.

The current revival path exposes a concrete multi-session constraint. `packages/coding-agent/src/main.ts:1969-1975` documents that the persisted-subagent reviver is limited to non-ACP sessions because ACP keeps several concurrent top-level sessions. Lines `1976-1986` still install one process-global `setPersistedSubagentReviverFactory`, so the most recent session can clobber the factory used by earlier sessions. The bridge must preserve per-session ownership instead of extending this global pattern.

OMP remains the sole scheduler and policy owner. JCode's native swarm is a second control loop with its own coordinator, plan, channels, recursive spawning, and worker limits, so it stays disabled. The prior JCode runtime review recommends adopting the private API-driven worker runtime behind an OMP-owned connector, not adopting JCode as coordinator or manager (`/Users/jamie/Obsidean/omp-setup-vault/06 Reference/2026-08-27-durable-outputs/jcode-worker-runtime-research-2026-08-27.md`, lines 5-9 and 233-241).

Prior-art research supports borrowing structured semantics without making any one external protocol canonical. JSON-RPC contributes request IDs and structured errors; MCP contributes handshake, capabilities, progress, and cancellation; A2A contributes task and context identity, terminal state, streaming, replay, and discovery; tmux contributes private daemon and attach persistence. IRC remains a transport adapter, not the identity or envelope authority (`.bridge-prior-art.tmp`, lines 7-18 and 20-30).

## Decision

Build a thin OMP-owned, versioned envelope above independent transport and execution adapters.

### Session directory

Use a broker-backed session directory as the authority for cross-process session resolution. Store `SessionAddress` records with namespace, host or process, backend, session ID, and generation. Resolve messages through opaque addresses and generation checks. Preserve compare-and-swap updates, tombstones, monotonic event ordering, and delivery isolation per owner. Keep the RPC request ID distinct from the envelope message ID and idempotency key.

`ResourcePolicy` extends the existing async-job, run-collection, OpenTelemetry, and hub/session snapshot accounting. The broker enforces bounded queues, acknowledgement or acceptance watermarks, replay cursors, fairness, and backpressure. OMP owns scheduling, authorization, route policy, and terminal receipt decisions.

### Structured backend adapters

Define `ExecutionBackend` as the OMP boundary for Pi and JCode. Backends expose structured spawn or attach, input, event stream, cancellation, terminal result, resume or revive, model attribution, and telemetry. They return OMP envelopes and receipts rather than leaking backend-specific frames into OMP scheduling.

The Pi adapter uses Pi's structured JSON or RPC modes, including session and lifecycle events, streamed text deltas, message or turn termination, usage, provider, and model fields. ACP is acceptable where it is the compatible structured protocol, but ACP is an adapter choice, not the OMP envelope.

The JCode adapter adopts JCode's private daemon and ACP or equivalent structured API semantics inside the adapter. It may use the stable daemon or API route for private pooled sessions, event streaming, cancellation, and runtime information. It must not make JCode's protocol, daemon state, native plan, or native swarm canonical to OMP. JCode native swarm remains disabled.

Both adapters preserve requested and resolved route values separately. Missing fallback evidence is recorded as `unobserved`, not inferred from a successful response.

### Rollout and proof

Keep the bridge behind the OMP scheduler and existing policy gates. The implementation is accepted only when focused proof demonstrates the two seams, structured Pi and JCode lifecycle behavior, session isolation across generations, reconnect or replay behavior, cancellation and terminal-state handling, and contract validation for malformed or duplicate envelopes. The direct Pi route remains the earlier experiment gate recorded in the durable design reference; this bridge decision does not reorder that gate without an explicit product decision (`/Users/jamie/Obsidean/omp-setup-vault/06 Reference/2026-08-27-durable-outputs/DESIGN.md`, lines 8-11 and 144-159).

## Evidence at this checkpoint

- Core modules exist under `packages/coding-agent/src/bridge/core/`. The lane verified address round-tripping, envelope creation and a legal delivery transition, and file-directory register, lookup, and tombstone behavior. CAS, expiry ordering, and two-process isolation were not independently verified.
- Runtime modules exist under `packages/coding-agent/src/bridge/runtime/`. A deterministic coordinator smoke covered caller-provided admission hooks, bounded UTF-8 result accounting, resource transitions, cancellation and resume handles, and attribution defaults. This is a standalone runtime proof, not evidence of wiring into existing OMP owners.
- The Pi adapter exists under `packages/coding-agent/src/bridge/backends/pi/`, with `packages/coding-agent/test/bridge-pi-backend.test.ts`. Its focused build and test passed, and an installed Pi structured JSON smoke observed session, streaming lifecycle, usage, provider/model, and terminal events. Adapter cancellation and resume were implemented but not independently exercised in that run.
- The JCode adapter exists under `packages/coding-agent/src/bridge/backends/jcode/`, with `packages/coding-agent/test/bridge-jcode-backend.test.ts`. Its focused test passed against a structured transport covering initialization, multiple sessions, prompt, load, cancel, text deltas, and completion events. Real installed-runtime cancellation, resource release, reconnect replay, and persistence were not verified.
- The integration gate remains open. The reviewer and integration-owner reports found no non-test consumers, no `packages/coding-agent/src/bridge/index.ts`, no shared OMP integration changes, and a parse-corrupt `packages/coding-agent/src/bridge/transport/transport.ts` with an undeclared `BrokerTransportServer.#clients`. Contract verification was held. The global reviver in `main.ts` remains unchanged.

These reports support documenting standalone artifacts only. They do not support a claim of an end-to-end broker-backed session directory, ACP multi-session revival, or accepted bridge rollout.

## Consequences

- OMP gains one stable identity and envelope model across IRC, local sockets, ACP, JSON-RPC, and backend-specific transports.
- Concurrent top-level sessions no longer depend on one process-global revival factory or one process-global agent namespace.
- Pi and JCode can evolve behind adapters without making either runtime's wire format an OMP-wide contract.
- OMP retains scheduler, policy, route, resource, and receipt authority. JCode cannot become a second scheduler through native swarm.
- Broker persistence, generation checks, replay, acknowledgements, and deduplication add state and failure cases that focused contract proof must cover.
- Structured protocols preserve event and terminal semantics, but they do not by themselves provide OS isolation, authorization, or complete fallback evidence. The adapters and OMP policy layer must record those facts explicitly.
- The bridge is a durable target architecture, not evidence that the implementation has landed. The focused lanes prove parts of the standalone modules, while transport parsing, shared integration, per-session revival ownership, and the contract gate remain unresolved. The record therefore stays proposed.

## Citations

- `packages/coding-agent/src/main.ts:1969-1975` — persisted revival factory is bound to one top-level session; ACP multi-session use makes a process-global factory clobber-prone.
- `docs/sdk.md:97-99` — default process-global registry admits one `"Main"` identity per generation.
- `docs/tools/hub.md:14-21` — current hub collaborators and process-global bus, registry, lifecycle, and broker surfaces.
- `.bridge-prior-art.tmp:7-30` — structured protocol comparison, canonical composition, failure modes, and smallest viable bridge.
- `/Users/jamie/Obsidean/omp-setup-vault/06 Reference/2026-08-27-durable-outputs/DESIGN.md:8-11,144-159` — direct Pi gate and later bridge ordering.
- `/Users/jamie/Obsidean/omp-setup-vault/06 Reference/2026-08-27-durable-outputs/jcode-worker-runtime-research-2026-08-27.md:5-9,86-145,233-241` — private API-driven JCode worker boundary, structured events, cancellation, and native swarm exclusion.
