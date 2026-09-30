# Session-stats CLI grounding

## Ownership and layout

`scripts/session-stats/` is the existing owner for session-corpus parsing and analysis. It is a mixed Bun/CPython tool directory:

```text
scripts/session-stats/
  sync.py                     incremental JSONL -> ~/.omp/stats.db
  analyze.py                  SQLite read-only analyses: tools, edits, followups
  audit.ts                    direct JSONL usage scan and optional LLM audit
  audit.test.ts               Bun tests for audit parsing/scanning
  audit-prompt.md             classifier prompt
  analyze_*.py, harmony_*.py,
  optimize_*.py, plot_*.py    standalone analyses/plots over stats.db
  out/                        checked-in/generated plot outputs
```

The README describes this as ad-hoc, SQLite-backed analysis over `~/.omp/agent/sessions/`; the Rust implementation previously in this directory was retired. Existing ownership should be extended rather than creating a second parser or a second session CLI.

## Entry points and runtime choices

### Existing sync/analysis path (Python)

`sync.py:main` uses `argparse` and accepts:

```sh
python3 scripts/session-stats/sync.py
python3 scripts/session-stats/sync.py --workers 16 --full
python3 scripts/session-stats/sync.py --limit 200
python3 scripts/session-stats/sync.py --root /some/session/root
```

Defaults are `Path.home()/".omp/agent/sessions"` and `Path.home()/".omp/stats.db"`. It requires the Python package `tiktoken`; the README's preparation command is `pip install tiktoken`. The persisted tokenizer is `o200k_base`. Sync is incremental using per-file mtime, size, byte offset, line count, and parser version; `--full` rebuilds each discovered file's rows.

`analyze.py:main` also uses `argparse`, with required subcommands `tools`, `edits`, and `followups`. It opens `~/.omp/stats.db` read-only and exits with `db not found ... Run sync.py first.` if absent. Common filters include `-n/--limit`, `--folder`, and `--since`; `followups` additionally has detector-specific options including `--max-fix`, `--min-dup`, and `--show`.

### Existing audit path (Bun/TypeScript)

`audit.ts:main` is executable by Bun and guarded by `if (import.meta.main)` (`audit.ts:1312-1463`). It reads JSONL directly, does not require `sync.py` or `tiktoken`, and imports workspace packages `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, and `@oh-my-pi/pi-utils`. Its default source is `~/.omp/agent/sessions`; default classifier is `anthropic/claude-sonnet-4-6`.

Exact direct invocations documented by the file/README:

```sh
bun scripts/session-stats/audit.ts
bun scripts/session-stats/audit.ts --since 3d --no-llm
bun scripts/session-stats/audit.ts --folder Projects-pi --max-llm 6
bun scripts/session-stats/audit.ts --json /tmp/audit.json
bun scripts/session-stats/audit.ts --min-cost 5 --max-llm 8 --json /tmp/audit.json
bun scripts/session-stats/audit.ts --digest-dir /tmp/digests
bun scripts/session-stats/audit.ts --session parser
bun scripts/session-stats/audit.ts --no-cache
```

`audit.test.ts` imports and tests exported `parseSince`, `normalizeReadPath`, and `scanFile`; its synthetic JSONL fixture verifies usage totals, turn segmentation, spawn/result handling, read grouping/residency, and assistant text.

## Package tooling

The repository root `package.json` declares `packageManager: bun@1.4.0` and currently owns these aliases:

```json
"stats:sync": "python3 scripts/session-stats/sync.py",
"stats:tools": "python3 scripts/session-stats/analyze.py tools",
"stats:edits": "python3 scripts/session-stats/analyze.py edits",
"stats:followups": "python3 scripts/session-stats/analyze.py followups",
"stats:audit": "bun scripts/session-stats/audit.ts"
```

Therefore the compatible command convention is root-level `bun run stats:<command>`, with arguments after `--`:

```sh
bun run stats:sync
bun run stats:tools -- --by d --top 8
bun run stats:edits -- --since w
bun run stats:followups -- --max-fix 2 --min-dup 8 --show 20
bun run stats:audit -- --since 3d --no-llm
```

No `scripts/session-stats/package.json`, Python project manifest, or dedicated fixture directory exists. The Python sync dependency is external (`tiktoken`); Bun dependencies resolve from the root workspace installation.

## Smallest compatible `sol-study` organization

Add `sol-study` as one command under the existing `scripts/session-stats/` owner, not as a parallel top-level parser. The least disruptive shape is a new subcommand dispatcher in the existing owner (or a thin owner-local entry point if the implementation needs a different runtime), preserving the current runtime boundary:

```sh
bun run stats:sol-study -- --help
bun run stats:sol-study -- ingest --manifest /path/to/manifest
bun run stats:sol-study -- snapshot --window 14 --cutoff 2026-08-29T00:00:00Z
bun run stats:sol-study -- snapshot --window 30 --cutoff 2026-08-29T00:00:00Z
bun run stats:sol-study -- verify --snapshot /path/to/frozen.sqlite
bun run stats:sol-study -- report --snapshot /path/to/frozen.sqlite
```

These are organization patterns, not implemented commands. The workflow plan requires explicit manifest, cutoff, append-only corpus, frozen snapshot, and verification/report phases; do not overload the mutable `sync.py` flags or the moving `audit.ts --since` window for study semantics. The study command should accept explicit paths/cutoffs and default only to the HDD corpus layout defined by the workflow, while leaving the legacy `stats:*` aliases unchanged.

## Fixtures and verification commands

The only repository fixture found for this subsystem is the in-test synthetic transcript constructed in `audit.test.ts`; no checked-in corpus fixture is present. The existing targeted test command is:

```sh
bun test scripts/session-stats/audit.test.ts
```

CLI smoke/help verification patterns for the current commands are:

```sh
bun run stats:sync -- --help
bun run stats:tools -- --help
bun run stats:edits -- --help
bun run stats:followups -- --help
bun run stats:audit -- --help
```

For a future `sol-study`, the minimum command-level verification should exercise help, a manifest-only or synthetic fixture ingest, both fixed windows with the explicit cutoff, frozen snapshot verification, and report output. Exact expected invocations should retain the root alias plus `--` separator shown above. This document makes no implementation claim and intentionally does not run builds, linters, or tests.
