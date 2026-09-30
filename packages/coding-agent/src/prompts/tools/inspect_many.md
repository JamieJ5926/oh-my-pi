Batch codebase inspection with parallel reads, coverage tracking, and synthesis.

Generates a manifest of files in scope, chunks them by module/package, dispatches parallel reader jobs, tracks coverage (which entries were read/failed/skipped), recovers gaps, and synthesizes findings across chunks.

**Use for whole-codebase or large-scope investigation.** For reading a few specific files, use semicolon-delimited read syntax: `read("src/a.ts; src/b.ts; src/c.ts")`.

**Selectors:**
- `{ kind: "repository" }` — entire repository
- `{ kind: "path", path: "src" }` — specific directory or file
- `{ kind: "glob", pattern: "**/*.test.ts" }` — glob pattern

**Exclusions:** optional array of the same ScopeSelector objects the capability contract accepts (`InspectManyRequest.exclusions` / `generateManifest`). Dropped paths never enter the manifest. Accepted forms:
- `{ kind: "repository" }` — exclude everything (empty manifest)
- `{ kind: "path", path: "dist" }` — exclude a directory or file
- `{ kind: "glob", pattern: "**/*.generated.ts" }` — exclude by glob
- `{ kind: "package", name: "foo" }` — exclude a package name
- `{ kind: "module", name: "bar" }` — exclude a module name

**Constraints:**
- `maxFilesPerChunk` — limit files per reader job (default: unlimited)
- `targetSourceTokensPerChunk` — target tokens per chunk (default: unlimited)
- `maxConcurrency` — max parallel reader jobs (default: 4)
- `requireCompleteCoverage` — fail if any manifest entries are inaccessible (default: true)

Returns manifest, chunk plan, findings with evidence, and coverage report.
