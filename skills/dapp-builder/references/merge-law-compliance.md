# Merge-Law Compliance

How to build a contract merge that passes the laws freenet-core checks
(freenet-core#5320) and keeps passing them as the contract grows caps,
removals and work bounds. Read `contract-patterns.md` → "Merge Law
Requirements" first for the basic laws and property tests; this file covers
what goes wrong once a merge is more than a plain union.

## The laws, as the network checks them

All comparisons are on exact canonical bytes. `fdev verify-merge` and peers
run the same checks; only Violation-severity laws can lead to a contract's
removal. For valid states `A`, `B`, `C` and a delta `D`:

| Law | Statement | Severity |
|---|---|---|
| State idempotence | `merge(A, A) == A` | Violation |
| State commutativity | `merge(A, B) == merge(B, A)` | Violation |
| State associativity | `merge(merge(A, B), C) == merge(A, merge(B, C))`, or the heal-guarded form below | Violation |
| Emitted state validity | every state `update_state` emits passes `validate_state` | Violation |
| Determinism | update, summary and delta give the same bytes for the same inputs | Violation |
| Delta order | two deltas computed against the same base reach the same state in either order | Violation |
| Path agreement | applying `get_state_delta(B, summarize(A))` to `A` equals merging the whole state `B` into `A` | Violation |
| Transition path agreement | for an observed step `base -> result`, `merge(base, result) == result` | Violation |
| Reconciliation | two valid divergent states reconcile through summary and delta rounds instead of cycling | Violation |
| Delta idempotence | `apply(apply(A, D), D) == apply(A, D)` | Diagnostic |

Delta idempotence is reported but cannot cause removal, because a bounded cap
can legitimately re-judge a re-delivered delta. Aim for it anyway: delivery is
at-least-once.

**Absorption**, `merge(merge(A, B), B) == merge(A, B)`, follows from the laws
above and is the one most cap and cleanup designs break. The network checks it
only inside the associativity heal step, so test it directly in your own
fuzzer.

**Heal-guarded associativity** (freenet-core#5924). A contract whose cap or
eviction can free a slot, through a removal or a raised cap, may not be
strictly associative: only one grouping refills the freed slot. That is
allowed if the groupings converge. With `L = merge(merge(A, B), C)`,
`R = merge(A, merge(B, C))`, `L != R`, and `M = merge(L, R)`:

- `merge(R, L)` must equal `M`;
- repeatedly merging `L`, `R`, `A`, `B` and `C` into `M` must reach a state
  that no further merge changes within 4 rounds, and each step that changes
  `M` must absorb re-delivery (`merge(merge(M, X), X) == merge(M, X)`).

A repeated state (a cycle), an invalid `L` or `R`, or a contract that refuses
one of these merges is a violation; running out of rounds is inconclusive. A
merge whose result keeps moving (averaging, a counter that climbs on every
exchange, last-write-wins on a wrapping sequence number) still fails. A cap
that keeps the top N records by each record's own content, with no removals
and a fixed N, is strictly associative and needs none of this.

## Merge = one canonical procedure over the union

A merge must be a deterministic function of the union of both states, so
design it as "union, then choose": take every record either side holds, then
run one procedure that decides what to keep. For that to satisfy absorption,
**the chooser must give the same answer on any set between its result and its
input.** If re-merging a record the first merge dropped can change the
outcome, absorption fails.

Rules that follow from it:

- **Every cap is the last filter of the one canonical procedure.** A cap
  applied in `apply_delta`, before cleanup runs, judges a set that cleanup
  later changes, so the order of arrival leaks into the result.
- **Never judge liveness or eligibility over a set that later steps shrink.**
  A cap that keeps "live" records, where liveness depends on records that
  cleanup then removes, keeps different records depending on what was present
  before cleanup. Judge over facts that do not change during the procedure, or
  over the records already admitted.
- **Prefer greedy admission.** Walk records in a fixed order derived only
  from each record's own content, admit each only if it fits given the records
  already admitted plus facts the procedure does not change, and never remove
  a record once admitted.
- **Otherwise run removals and caps in one bounded loop to a fixpoint.** When
  removing one record can make another removable (or free a slot under a cap),
  loop until a pass removes nothing. If each pass only shrinks the set, the
  loop terminates in at most `n + 1` passes. Separate one-shot passes in a
  fixed order leave states that a second merge changes again. The loop is
  necessary but not sufficient: if more than one fixpoint exists, the result
  depends on the starting set and absorption still fails.
- **Normalize held state on every apply.** `validate_state` usually accepts
  states no merge produces (a full-state PUT runs only validation): duplicates,
  records over a cap, records whose dependencies are gone. Run the same
  cleanup over held state on every apply, so every state a merge produces is a
  fixpoint of `merge(S, S)`. A valid state that is not such a fixpoint is
  reported under state idempotence, so prefer a `validate_state` that rejects
  states cleanup would change, where an upgrade path does not need it to
  accept them.

## Deduplicate within one delta

Two byte-identical copies of a record in the *same* delta both pass a check
made against held state, and the state ends up holding both. Deduplicate
incoming records among themselves as well as against held state (see
`contract-patterns.md` → "Decide What One Bad Entry in a Delta Does").

## Summaries must tell different content apart

If two peers hold different records under the same key (the same version
number, the same slot) and their summaries name only the key, each peer
believes the other is current and they never reconcile. Put enough of the
content in the summary to detect the difference, for example `(version,
digest of the record)` instead of `version`. The merge must then resolve the
two records the same way on both peers. Keep the summary built from exactly
the record set the merge and the readers use.

## Work bounds that do not break the laws

A contract has to bound the work an incoming state or delta can cause, and a
bound placed wrongly breaks the laws itself.

- **Refuse before cryptography, over the incoming state's own caps.** Count
  records first and refuse a whole state holding more than its own
  configuration allows, before checking any signature. Make `validate_state`
  enforce the same caps, so a state it accepts is never refused by merge.
- **Do not trim whole-state merges.** A trim chooses records before the merged
  state's own removals and caps run, so the two directions of one exchange
  differ. Apply every incoming record and let the canonical procedure decide.
- **A trimmed network delta must make progress every round.** A delta built
  against a summary, without the receiver's state, may be trimmed to a work
  bound, with the rest following in later rounds. Make each trimmed delta
  usable on its own: include the records the kept records depend on (the
  records needed to verify them), so the receiver keeps something every round
  instead of pruning it. Run anything that adds records to the delta before
  the trim. Size the bound so the largest record together with its
  dependencies fits, or that record never arrives. Test that a large backlog
  converges within a bounded number of rounds.

## A validly signed record never makes a merge fail

For records signed independently by different parties, return `Err` from a
merge only for a forgery (a signature that does not verify) or an exceeded
work bound. A record that is validly signed but that this state
does not admit (over a cap, referencing something unknown, disallowed by the
current configuration) is skipped on arrival and dropped where held, by the
same rule in both places. An `Err` for such a record fails every merge with
any peer holding it, in one direction only, permanently, and only the record's
author can repair it. The verifier also reports a contract that refuses to
merge two valid states in the associativity heal step as a violation. Also make sure `validate_state` rejects anything a merge
would `Err` on, or a state that validation accepted can block every later
merge.

## Testing

Write these before trusting the merge, and run them on every change to it:

- **A merge-law fuzzer.** Generate pairs and triples of valid states,
  including adversarial ones (duplicates, records over caps, colliding
  versions), and check idempotence, commutativity, absorption, heal-guarded
  associativity, and apply-twice equals apply-once for deltas.
- **Fork tests across many seeds.** Grow two forks from a common ancestor with
  random operations, exchange states and deltas, and require convergence, a
  commutative first exchange, and a `merge(S, S)` fixpoint after every apply.
  A small default seed count is a smoke test; run a large count (River's
  `common/tests/fork_merge_closure_test.rs` uses `FORK_SEEDS=1000`) before
  merging a merge change, because some defects appear only there.
- **Real states as fixpoints.** Capture real states and check each is a
  fixpoint of `merge(S, S)` and that pairs commute. Run `fdev verify-merge`
  (the same verifier the network runs, previously `fdev conformance`) on them:
  `fdev verify-merge --wasm contract.wasm --state s1.bin --state s2.bin`, and
  pass observed steps with `--transition BASE RESULT`, without which
  transition path agreement is not checked. It cannot check a contract that
  needs related contracts (see `SKILL.md`).
- **Mutation-check the fuzzer.** Move a cap ahead of cleanup, delete a
  dedup, or drop the digest from a summary, and confirm the fuzzer fails. A
  fuzzer that stays green under those changes does not cover them.
