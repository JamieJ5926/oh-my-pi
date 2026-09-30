# M1 shared contract design

## Caller usage

```ts
const inspection = await inspectMany({
  objective: "Find every capability gap",
  scope: [{ kind: "repository" }],
  exclusions: [],
  constraints: {
    maxAttemptsPerChunk: 2,
    allowLineRangeSplit: false,
    requireCompleteCoverage: true,
    repositoryRevisionPolicy: { kind: "pinned" },
  },
  output: { kind: "findings" },
});

const change = await changeSet({
  objective: "Implement the accepted gaps",
  inspection,
  constraints: { maxAttemptsPerUnit: 2 },
});
```

Callers declare outcomes and boundaries. They never build chunks, coverage states, writer waves, or patch order.

## Organizing structure

Use immutable versioned records plus pure transition functions. Persist each accepted record under one operation directory. Store no mutable optional-field state bag. Read and write lifecycles use discriminated unions. Artifact filenames carry their stable ID and schema version. A small operation index points to accepted record IDs and can be reconstructed from artifacts.

This rejects a full event log for M1. Event replay adds ordering and migration work before the first vertical slice needs it. Immutable records retain crash recovery and auditability with less machinery. Add an event journal only if later measurements prove record reconstruction too expensive.

## Shared identifiers

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

type OperationId = Brand<string, "OperationId">;
type ManifestId = Brand<string, "ManifestId">;
type ManifestEntryId = Brand<string, "ManifestEntryId">;
type ChunkPlanId = Brand<string, "ChunkPlanId">;
type ChunkId = Brand<string, "ChunkId">;
type AttemptId = Brand<string, "AttemptId">;
type EvidencePacketId = Brand<string, "EvidencePacketId">;
type SynthesisNodeId = Brand<string, "SynthesisNodeId">;
type ChangePlanId = Brand<string, "ChangePlanId">;
type ChangeUnitId = Brand<string, "ChangeUnitId">;
type WriteWaveId = Brand<string, "WriteWaveId">;
type PatchId = Brand<string, "PatchId">;
type IntegrationRunId = Brand<string, "IntegrationRunId">;
```

Only boundary constructors create branded IDs. Constructors reject blank, malformed, or wrong-prefix strings.

## Versioned metadata

```ts
interface ArtifactMeta {
  readonly schemaVersion: "1";
  readonly createdAt: string;
  readonly operationId: OperationId;
}
```

Boundary parsers accept `unknown`, validate the full record, and return domain types. Internal functions trust domain values.

## Status and errors

```ts
type CapabilityStatus =
  | { kind: "complete" }
  | { kind: "partial"; gapIds: readonly string[] }
  | { kind: "failed"; error: CapabilityError }
  | { kind: "cancelled"; reason: string };

interface CapabilityError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly source?: string;
  readonly context: Readonly<Record<string, unknown>>;
}
```

Control flow branches on `code` and `retryable`. Messages remain diagnostic text.

## Inspection request

```ts
type ScopeSelector =
  | { kind: "path"; path: string }
  | { kind: "glob"; pattern: string }
  | { kind: "package"; name: string }
  | { kind: "module"; name: string }
  | { kind: "repository" };

type RevisionPolicy =
  | { kind: "pinned" }
  | { kind: "detect_and_report" };

interface InspectManyRequest {
  readonly objective: string;
  readonly scope: readonly [ScopeSelector, ...ScopeSelector[]];
  readonly exclusions: readonly ScopeSelector[];
  readonly constraints: {
    readonly maxConcurrency?: number;
    readonly maxAttemptsPerChunk: number;
    readonly targetSourceTokensPerChunk?: number;
    readonly maxFilesPerChunk?: number;
    readonly allowLineRangeSplit: boolean;
    readonly requireCompleteCoverage: boolean;
    readonly repositoryRevisionPolicy: RevisionPolicy;
  };
  readonly output: InspectOutputRequirements;
}
```

Repository scope requires at least one selector. Positive integer constructors validate counts once.

## Manifest

```ts
type ManifestEntryKind =
  | { kind: "file" }
  | { kind: "symlink"; target: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "unreadable"; reason: string };

interface ManifestEntry {
  readonly entryId: ManifestEntryId;
  readonly path: string;
  readonly kind: ManifestEntryKind;
  readonly sizeBytes: number;
  readonly estimatedTokens?: number;
  readonly contentHash?: string;
  readonly language?: string;
  readonly module?: string;
  readonly package?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface Manifest {
  readonly meta: ArtifactMeta;
  readonly manifestId: ManifestId;
  readonly repositoryRoot: string;
  readonly repositoryRevision: RevisionIdentity;
  readonly selectors: readonly ScopeSelector[];
  readonly exclusions: readonly ScopeSelector[];
  readonly entries: readonly ManifestEntry[];
}
```

The constructor normalizes and sorts paths. It rejects duplicate paths, duplicate IDs, outside-root entries, inconsistent hashes, and unsupported entries without an explicit status.

## Coverage

```ts
type CoverageState =
  | { kind: "unassigned" }
  | { kind: "assigned"; chunkId: ChunkId }
  | { kind: "processed"; packetId: EvidencePacketId }
  | { kind: "verified"; packetId: EvidencePacketId }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "failed"; errorCode: string };

interface CoverageRecord {
  readonly manifestEntryId: ManifestEntryId;
  readonly state: CoverageState;
  readonly attemptCount: number;
  readonly updatedAt: string;
}

interface CoverageLedger {
  readonly meta: ArtifactMeta;
  readonly manifestId: ManifestId;
  readonly records: ReadonlyMap<ManifestEntryId, CoverageRecord>;
}
```

`transitionCoverage` is exhaustive. It permits only the plan's transitions. A retry function alone may move failed to assigned. Duplicate assignment and regression throw typed errors.

## Chunk plan

```ts
interface ReadChunk {
  readonly chunkId: ChunkId;
  readonly objective: string;
  readonly assignedEntryIds: readonly [ManifestEntryId, ...ManifestEntryId[]];
  readonly readDependencyEntryIds: readonly ManifestEntryId[];
  readonly estimatedSourceTokens: number;
  readonly expectedOutputSchema: unknown;
}

interface ChunkPlan {
  readonly meta: ArtifactMeta;
  readonly chunkPlanId: ChunkPlanId;
  readonly manifestId: ManifestId;
  readonly policy: ChunkPolicySnapshot;
  readonly chunks: readonly ReadChunk[];
}
```

The validator proves the assigned-ID union equals every required manifest ID and that assigned-ID intersections are empty. Read dependencies may overlap.

## Attempts and evidence

```ts
interface AttemptRecord {
  readonly meta: ArtifactMeta;
  readonly attemptId: AttemptId;
  readonly chunkId: ChunkId;
  readonly ordinal: number;
  readonly jobId: string;
  readonly outcome: JobOutcome;
}

interface EvidenceReference {
  readonly manifestEntryId: ManifestEntryId;
  readonly path: string;
  readonly symbol?: string;
  readonly lineRange?: readonly [number, number];
}

interface Finding {
  readonly summary: string;
  readonly evidence: readonly [EvidenceReference, ...EvidenceReference[]];
}

interface EvidencePacket {
  readonly meta: ArtifactMeta;
  readonly packetId: EvidencePacketId;
  readonly chunkId: ChunkId;
  readonly attemptId: AttemptId;
  readonly processedEntryIds: readonly ManifestEntryId[];
  readonly skippedEntries: readonly { entryId: ManifestEntryId; reason: string }[];
  readonly findings: readonly Finding[];
  readonly uncertainties: readonly Uncertainty[];
}
```

Validation requires every finding to carry evidence. Processed IDs must belong to the chunk's assigned IDs. Unknown and duplicate IDs invalidate the packet.

## Synthesis

```ts
type SynthesisNode =
  | { kind: "leaf"; nodeId: SynthesisNodeId; packetId: EvidencePacketId }
  | { kind: "branch"; nodeId: SynthesisNodeId; childIds: readonly [SynthesisNodeId, SynthesisNodeId, ...SynthesisNodeId[]] };

interface SynthesisTree {
  readonly meta: ArtifactMeta;
  readonly rootId: SynthesisNodeId;
  readonly nodes: ReadonlyMap<SynthesisNodeId, SynthesisNode>;
}
```

The validator rejects cycles, missing children, duplicate leaves, and branches above the configured fan-in.

## Change planning

```ts
interface ChangeUnit {
  readonly unitId: ChangeUnitId;
  readonly objective: string;
  readonly ownedPaths: readonly [string, ...string[]];
  readonly dependencyIds: readonly ChangeUnitId[];
  readonly validationCommands: readonly [string, ...string[]];
  readonly isolation: "worktree" | "patch";
}

interface ChangePlan {
  readonly meta: ArtifactMeta;
  readonly changePlanId: ChangePlanId;
  readonly units: readonly [ChangeUnit, ...ChangeUnit[]];
}

interface WriteWave {
  readonly waveId: WriteWaveId;
  readonly unitIds: readonly [ChangeUnitId, ...ChangeUnitId[]];
}
```

The DAG validator rejects cycles, unknown dependencies, duplicate paths inside a unit, and path ownership overlap inside a wave. Topological ordering and tie-breaking use stable IDs.

## Patches and integration

```ts
type PatchValidation =
  | { kind: "accepted" }
  | { kind: "rejected"; code: string; message: string };

interface PatchRecord {
  readonly meta: ArtifactMeta;
  readonly patchId: PatchId;
  readonly unitId: ChangeUnitId;
  readonly baseRevision: RevisionIdentity;
  readonly touchedPaths: readonly string[];
  readonly patchPath: string;
  readonly validation: PatchValidation;
}

type IntegrationState =
  | { kind: "pending" }
  | { kind: "applying"; patchId: PatchId }
  | { kind: "accepted"; patchId: PatchId; revision: RevisionIdentity }
  | { kind: "rejected"; patchId: PatchId; error: CapabilityError }
  | { kind: "reverted"; patchId: PatchId; error: CapabilityError };

interface IntegrationRecord {
  readonly meta: ArtifactMeta;
  readonly integrationRunId: IntegrationRunId;
  readonly unitId: ChangeUnitId;
  readonly state: IntegrationState;
}
```

Only the integration owner creates integration transitions. Accepted sibling records remain immutable when another patch fails.

## Storage boundary

```ts
interface OperationStore {
  writeArtifact<T extends CapabilityArtifact>(artifact: T): Promise<void>;
  readArtifact(id: CapabilityArtifactId): Promise<CapabilityArtifact>;
  listArtifacts(operationId: OperationId): Promise<readonly CapabilityArtifactId[]>;
  reconstruct(operationId: OperationId): Promise<OperationSnapshot>;
}
```

Writes use a temporary file plus atomic rename. Writing an existing ID succeeds only when bytes match. Conflicting bytes return a typed idempotency error.

## Modules

- `packages/coding-agent/src/capability/contracts/ids.ts`
- `packages/coding-agent/src/capability/contracts/status.ts`
- `packages/coding-agent/src/capability/contracts/inspect.ts`
- `packages/coding-agent/src/capability/contracts/manifest.ts`
- `packages/coding-agent/src/capability/contracts/coverage.ts`
- `packages/coding-agent/src/capability/contracts/chunks.ts`
- `packages/coding-agent/src/capability/contracts/evidence.ts`
- `packages/coding-agent/src/capability/contracts/synthesis.ts`
- `packages/coding-agent/src/capability/contracts/change.ts`
- `packages/coding-agent/src/capability/contracts/integration.ts`
- `packages/coding-agent/src/capability/contracts/store.ts`
- `packages/coding-agent/src/capability/contracts/index.ts`

## M1 acceptance tests

- Branded ID constructors reject wrong prefixes and blanks.
- Boundary parsers reject unknown schema versions and malformed records.
- Coverage transitions accept only legal edges.
- Manifest construction rejects duplicates and outside-root paths.
- Chunk-plan validation proves exact ownership.
- Evidence validation rejects uncited findings and unknown entry IDs.
- DAG validation rejects cycles and overlapping ownership.
- Integration transitions reject invalid regressions.
- Rewriting identical immutable artifacts is idempotent. Conflicting bytes fail.
