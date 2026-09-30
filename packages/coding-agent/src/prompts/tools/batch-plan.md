# batch_plan

Builds and validates a structural multi-unit change plan. It computes deterministic dependency waves and saves the plan as a `local://` artifact for an implementer.

The planner describes intent, ownership, dependencies, and validation. It does not provide file contents.

## Schema

```typescript
{
  objective: string;
  units: Array<{
    objective: string;
    ownedPaths: string[];
    dependencyUnitIndexes?: number[];
    validationCommands: string[];
    isolation?: "patch" | "worktree";
Each array position mints a stable `change_unit_0000`-style ID. Dependencies use zero-based `dependencyUnitIndexes`; indexes must be unique, in range, and non-self.
  }>;
}
```
The tool mints `operationId` and `changePlanId`. Do not provide either field.

Every unit needs an explicit `change_unit_` ID. Dependency IDs must name those exact IDs. Unknown fields, including `payload`, are rejected.

## Returns

```typescript
{
  artifactUri: string;
  changePlanId: string;
  operationId: string;
  planDigest: string;
  batchWriteRequestTemplate: {
    artifactUri: string;
    manifest: {
      schemaVersion: "1";
      operationId: string;
      changePlanId: string;
      planDigest: string;
      entries: Array<{ unitId: string; writes: [] }>;
    };
  };
  waves: Array<{ waveId: string; unitIds: string[] }>;
  order: string[];
  warnings: string[];
}
```

Pass `batchWriteRequestTemplate` to the implementer. The implementer copies the complete request, fills only the nested `writes` arrays, and calls `batch_write` once. It must not wrap or nest the request again.
