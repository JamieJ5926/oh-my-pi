
### Session identity detail

`lib/ingest-session.ts:ingestSession` derives untagged `runId` from the top session's native id (falling back to JSONL basename); tagged runs use `<runTag>/<session-id-or-basename>`. It hashes only the main JSONL as `sourceSha`, while child actor JSONLs are discovered from the sibling directory and included in parsing. This means source hash is not a full tree hash. `writeRun`'s delete-by-run-id path is therefore the precise replacement boundary.
