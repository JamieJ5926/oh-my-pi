# Capability layer implementation workflow

## Target

Repository: `/Users/jamie/Projects/omp-owned`.

Baseline: `2e29267`.

Existing user changes remain outside worker ownership unless a later unit proves a direct dependency:

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/sdk.ts`
- `packages/agent/src/rules-marker.test.ts`

## Done predicate

The capability layer is complete when the real CLI can execute `inspect_many` and `change_set` through the existing task substrate, resume from persisted operation artifacts, and satisfy all of these checks:

1. `bun run check` exits zero.
2. Focused capability tests pass.
3. Existing straggler tests pass, including `bun test packages/coding-agent/test/straggler-integration.test.ts`.
4. A read-path smoke run freezes a manifest, creates deterministic chunks, validates evidence, computes exact coverage, schedules recovery for missing entries, reduces evidence hierarchically, and returns a cited result.
5. A write-path smoke run creates a validated ownership and dependency DAG, runs non-conflicting writer waves in isolation, validates patches, integrates them in dependency order, rejects a bad patch without losing accepted siblings, runs targeted and combined tests, and returns the final state.
6. `bun packages/coding-agent/src/cli.ts --smoke-test` exits zero.

## Ownership boundaries

The deterministic capability layer owns operation contracts, manifests, chunks, evidence packets, coverage state, synthesis trees, change plans, ownership DAGs, writer waves, patch records, integration state, persistence, and resumability.

The execution substrate remains unchanged in responsibility. `AsyncJobManager`, `TaskTool`, `BatchStragglerTracker`, model routing, isolation runners, and worktree patch capture execute already-defined jobs. They do not discover scope, construct chunks, infer coverage, synthesize results, or integrate patches.

One integration owner controls shared entry points, exports, persistence wiring, and public capability registration. Parallel workers own disjoint modules or isolated worktrees. No two writers modify one file in the same wave.

## Dependency order and verification gates

### Unit 0. Baseline and verification harness

Hypothesis: existing focused checks can detect regressions in the substrate before capability code exists.

Work:

- Record the exact focused commands and expected baseline behavior.
- Add the smallest rerunnable smoke harness needed to exercise operation artifacts end to end.
- Do not change runtime behavior.

Gate:

- Existing focused substrate and straggler tests pass.
- The new harness fails only because `inspect_many` and `change_set` are absent.

### Unit 1. Shared contracts and identifiers

Hypothesis: branded identifiers and discriminated state records can represent every legal read and write lifecycle without synchronized optional fields.

Data shapes:

- Branded operation, manifest, entry, chunk, attempt, evidence, synthesis, change-unit, wave, patch, and integration IDs.
- Versioned operation metadata.
- Discriminated read-operation and write-operation states.
- Explicit terminal failure and rejection records.
- Boundary parsers for persisted or worker-supplied `unknown` data.

Gate:

- Type checks pass.
- Contract tests reject malformed versions, mixed identifiers, invalid transitions, and incomplete terminal records.

### Unit 2. Operation artifact store

Hypothesis: immutable versioned artifacts plus an append-only transition journal make operations reconstructable and retry-safe.

Ownership:

- One storage module owns layout, atomic writes, loading, schema rejection, and reconstruction.
- No orchestration policy enters the storage module.

Gate:

- Round-trip, crash-interruption, idempotent replay, schema mismatch, and corrupted artifact tests pass.

### Unit 3. Manifest generation

Hypothesis: a frozen normalized manifest can represent the declared repository scope with stable opaque entry IDs.

Gate:

- Repeated generation from the same frozen inputs yields the same ordered entries and IDs.
- Symlink, ignored path, duplicate path, and changed-file cases have explicit outcomes.

### Unit 4. Deterministic chunk planning

Hypothesis: pure chunk planning can partition every manifest entry exactly once before batching.

Boundary order:

1. Package or module.
2. Directory.
3. Related file group.
4. File.
5. Line range only when required.

Gate:

- Repeated planning is byte-stable.
- No missing or duplicate manifest entry IDs.
- Chunk size boundaries and oversized-file behavior pass focused tests.

Throughput checkpoint: run one representative repository scope through Units 1 through 4. Record manifest size, chunk count, planning duration, artifact size, and any manual step. Do not continue if the harness cannot deterministically reproduce the plan.

### Unit 5. Evidence packets and coverage ledger

Hypothesis: worker success is distinct from verified coverage.

Data shapes:

- Evidence packets carry chunk ID, attempt ID, covered manifest entry IDs, cited claims, diagnostics, and terminal status.
- Coverage states follow explicit transitions from unassigned to assigned to processed to verified, with separate failed and invalid outcomes.

Gate:

- Invalid evidence cannot advance coverage.
- Duplicate attempts are idempotent.
- Exact verified, missing, invalid, and retryable sets are computed from IDs rather than prose.

### Unit 6. Coverage recovery

Hypothesis: recovery can schedule only missing or invalid scope without repeating verified work.

Gate:

- A partial reader run produces minimal recovery jobs.
- Retry classification respects existing task-class and straggler behavior.
- Exhausted entries remain explicit gaps and cannot be synthesized as complete.

### Unit 7. Hierarchical synthesis

Hypothesis: a bounded reduction tree can preserve evidence references while avoiding one unbounded final prompt.

Gate:

- Every synthesized claim traces to validated evidence packet IDs and repository citations.
- Fan-in limits hold.
- Missing coverage prevents a complete verdict unless the contract permits a partial result.

### Unit 8. `inspect_many`

Hypothesis: one public contract can compose manifest, chunking, execution, evidence validation, recovery, coverage, synthesis, persistence, and resume.

Ownership:

- One integration owner wires the public capability and exports.
- The existing dispatcher receives defined reader jobs only.

Gate:

- Real smoke run proves input-to-output flow.
- Resume after interruption converges to the same result.
- Existing routing and straggler tests remain green.

### Unit 9. Change planning and ownership DAG

Hypothesis: change units with explicit file ownership and dependencies can make concurrent writes safe by construction.

Data shapes:

- Change units declare owned files, dependencies, intended behavior, validation commands, and isolation requirements.
- DAG validation rejects cycles, unknown dependencies, duplicate ownership in a wave, and undeclared writable paths.

Gate:

- Topological ordering is deterministic.
- Conflicting owners cannot enter the same wave.
- Independent units form parallel waves.

### Unit 10. Writer execution and patch validation

Hypothesis: isolated writers can return patches and metadata without mutating the integration tree.

Reuse:

- Existing isolation runner and `captureDeltaPatch` produce candidate patches.
- The new layer validates declared ownership, base identity, touched paths, patch applicability, forbidden files, and required metadata.

Gate:

- Out-of-scope, stale-base, malformed, overlapping, and forbidden-path patches are rejected.
- Valid sibling patches remain available after one rejection.

### Unit 11. Ordered integration, tests, and rollback

Hypothesis: a single deterministic integrator can apply one ready patch at a time and reject or reverse only the failing patch.

Ownership:

- One integration owner is the sole writer to the target worktree during integration.
- Workers never merge or apply patches directly.

Gate:

- Dependency order is enforced.
- Targeted tests run after each patch.
- Combined tests run after each wave.
- Failed patches restore the pre-patch tree without deleting accepted sibling work.
- Resume reconstructs accepted, rejected, pending, and reverted states.

### Unit 12. `change_set`

Hypothesis: one public contract can compose inspection, planning, DAG validation, writer waves, patch validation, ordered integration, tests, review, persistence, and rollback.

Gate:

- Real smoke run proves the complete path.
- One deliberately invalid sibling patch is rejected while another valid patch lands.
- Resume converges without duplicate application.

### Unit 13. Final verification and cleanup

Gate:

- Run the full done predicate.
- Run comment review and host-mapped deslop.
- Remove obsolete scaffolds and unused exports.
- Update tests and project-vault current-state, feature, and decision records.
- Independent review inspects the frozen diff and runtime artifacts.

## Parallel seams

Safe parallel work exists only after Unit 1 fixes shared contracts.

- Manifest fixtures and chunk-planner tests may proceed in parallel on disjoint files.
- Evidence validation and artifact-store tests may proceed in parallel when their interfaces are frozen.
- Read-path synthesis and write-path DAG exploration may proceed in parallel after shared identifiers stabilize.
- Patch-validation fixtures and integration rollback fixtures may proceed in parallel on disjoint test files.

Shared exports, operation registration, persistent schema definitions, and integration entry points remain single-writer boundaries.

## Audit trail

Append one row per unit or design decision to `.audit/capability-layer.tsv`. Evidence points to focused command output, runtime artifacts, or exact source paths. Negative and inconclusive results remain in the log. The log is reviewed against the final diff before handoff.
