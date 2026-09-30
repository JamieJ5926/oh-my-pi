# batch_write

Validates an implementer-authored write manifest against a structural plan artifact, publishes immutable review artifacts, and applies full-file writes in deterministic plan order.

## Schema

```typescript
{
  artifactUri: string;
  manifest: {
    schemaVersion: "1";
    operationId: string;
    changePlanId: string;
    planDigest: string;
    entries: Array<{
      unitId: string;
      writes: Array<{
        kind: "full_content";
        path: string;
        content: string;
      }>;
    }>;
  };
}
```

Every plan unit needs exactly one manifest entry and at least one write. Paths must be workspace-relative, safe, and owned by the matching unit. Validation happens before any workspace write. The validated manifest is content-addressed and published before application.

Start from the `batchWriteRequestTemplate` that `batch_plan` returned. Copy `artifactUri`, `operationId`, `changePlanId`, `planDigest`, and every `unitId` verbatim from the template and fill in only the `writes` arrays. Never retype these values; a single transposed character in `artifactUri` makes the plan artifact unresolvable.

Writes run sequentially by plan wave, unit ID, and normalized path. A failure stops later work. The result distinguishes intended patches from paths that actually completed.

## Returns

```typescript
{
  status:
    | "applied"
    | "preflight_rejected"
    | "manifest_persistence_failed"
    | "runtime_failed"
    | "receipt_persistence_failed";
  manifestUri?: string;
  receiptUri?: string;
  failedUnitId?: string;
  waves: Array<{ waveId: string; unitIds: string[] }>;
  patches: Array<{ patchId: string; unitId: string; touchedPaths: string[] }>;
  states: Array<{ unitId: string; state: IntegrationState }>;
  appliedPaths: string[];
  pendingPaths: string[];
  issues?: ManifestIssue[];
  error?: CapabilityError;
}
```

`applied` means all manifest writes were applied. It does not mean the plan is validated. The implementer must run each unit's declared validation commands through the normal approved execution tool, then give that evidence to the reviewer.
