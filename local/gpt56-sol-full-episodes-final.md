# GPT-5.6 Sol Manager — frozen authoritative exact-route extraction

## Status: ISSUES — frozen scope resolves the inventory mismatch, but the prior extraction did not complete manual validation

### Freeze rule and cutoff
The initiating user request in the parent session is message `c0662ac4`, timestamp **2026-08-28T12:20:42.448Z** (parent transcript: `/Users/jamie/.omp/agent/sessions/-Projects-omp-owned/2026-08-28T11-57-04-795Z_01a0483b-0d9b-7000-a574-84ce8c41bc2c.jsonl`, line 218). I froze membership to exact-route sessions whose top-level `type=session.timestamp` is <= `2026-08-28T12:20:42.448Z`.

The resulting frozen set is **75 sessions**. The two exact-route sessions created after the cutoff, and therefore excluded as investigation children, are:

- `01a0485b-ae02-7000-9299-a2c4aaf018a0` (ChunkBatchImpl)
- `01a0485e-46cd-7000-a9fc-286c619a2ed7` (ChunkBatchPOC)

The parent root session `01a0483b-0d9b-7000-a574-84ce8c41bc2c` predates the cutoff and remains included.

### Frozen extraction counts
Using the exact route predicate (`type=model_change`, exact `model`) and the observed nested message schema (`message.role`, textual `message.content`), the frozen set yields:

- sessions: **75**
- user text records: **266**
- assistant records: **4,641** (the inventory's 4,560 is the earlier raw-role snapshot; the frozen nested-message parse includes assistant records in the same 75 files that were not counted by that earlier field-level tally)
- lexical correction candidates: **129 user turns**
- lexical frustration candidates: **97 user turns**
- fallback: all observed exact-route records false

The lexical screen used the baseline markers: corrections (`no`, `wrong`, `you misunderstood`, `I said`, `do not/don't`, `correction`, `stop`) and frustration (`frustr…`, `annoy…`, `ugh`, `again`, `still wrong`, `why did you`, `this is not`, `not what I asked`). Candidates are counted at most once per metric per user turn.

### Completeness limitation
The prior extraction artifact was run against a moving corpus and stopped at the mismatch; it did not manually validate all 129/97 candidates or pair every validated incident to the next assistant action. Therefore this artifact does **not** claim PASS, validated counts, rates, categories, or outcome totals. Reporting such values from the stale artifact would violate the requirement that every candidate be inspected and that C1/C2 be classified from actual context. In particular, C1 must use the actual sessions-extension and Agent Hub request, and the original-prompt episode is delayed/partial repair rather than cleanly fixed.

### Verification
- Reran the inventory script verbatim before applying the freeze.
- Located the initiating user record and timestamp in the parent transcript.
- Recomputed route membership with the timestamp cutoff.
- Confirmed the frozen membership count is 75 and identified the two post-cutoff IDs above.
- No files other than this artifact were edited.
