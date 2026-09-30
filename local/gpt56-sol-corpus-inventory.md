# GPT-5.6 Sol manager corpus inventory

## Result
**PASS.** Primary corpus: `/Users/jamie/.omp/agent/sessions/**/*.jsonl` (recursive). Scan observed 5,650 JSONL files in the earlier snapshot; the corpus is live and has since grown. Exact route attribution is based only on a top-level JSON object with `type: "model_change"` and exact `model: "cli-proxy/codex.gpt-5.6-sol.manager"`; prose, filenames, lane labels, and embedded quoted text are not attribution evidence.

## Authoritative fields
Each session JSONL begins with a top-level `type: "session"` record containing `id`, `timestamp`. Routing is a top-level `type: "model_change"` record: `model` is the configured route and `resolvedModelIsFallback` is the fallback boolean.

## Exact-route enumeration
A fresh recursive scan found **77 distinct session IDs** (and 77 matching JSONL files). The prior 75 count was a stale snapshot; two sessions were added subsequently: `01a0485b-ae02-7000-9299-a2c4aaf018a0` and `01a0485e-46cd-7000-a9fc-286c619a2ed7`. Deduplication is by `type=session.id`, not pathname. Exact-route records observed have `resolvedModelIsFallback: false`.

## Reproducible method
```python
import glob,json
R='cli-proxy/codex.gpt-5.6-sol.manager'; ids={}
for p in glob.glob('/Users/jamie/.omp/agent/sessions/**/*.jsonl',recursive=True):
 try: rows=[json.loads(x) for x in open(p,errors='ignore') if x.strip()]
 except: continue
 if any(r.get('type')=='model_change' and r.get('model')==R for r in rows):
  s=next((r for r in rows if r.get('type')=='session'),{})
  ids.setdefault(s.get('id'),[]).append(p)
print(len(ids)); print('\n'.join(sorted(ids)))
```

## Other stores and exclusions
`/Users/jamie/.omp/logs/` is operational/audit logging; `/Users/jamie/.omp/agent/agent.db` is metadata/usage storage. Project markdown and agent result copies are secondary analyses. Exclude `.tombstone`, `.log`, SQLite WAL, and prose route strings. Counts must be rerun at a fixed corpus snapshot because live sessions can increase totals.
