# Merge-Law Compliance

How to build a contract merge that passes the laws freenet-core checks
(freenet-core#5320) and keeps passing them as the contract grows caps,
removals and work bounds. Read `contract-patterns.md` → "Merge Law
Requirements" first for the basic laws and property tests; this file covers
what goes wrong once a merge is more than a plain union.

## The laws, as the network checks them

All comparisons are on exact canonical bytes. For valid states `A`, `B`, `C`
and a delta `D`:

| Law | Statement |
|---|---|
| Idempotence | `merge(A, A) == A` |
| Commutativity | `merge(A, B) == merge(B, A)` |
| Absorption (re-delivery) | `merge(merge(A, B), B) == merge(A, B)` |
| Associativity | `merge(merge(A, B), C) == merge(A, merge(B, C))`, or the heal-guarded form below |
| Delta idempotence | `apply(apply(A, D), D) == apply(A, D)` |
| Delta order | the same deltas in any order, with duplicates, reach the same state |
| Validity | every state `update_state` emits passes `validate_state` |

**Heal-guarded associativity** (freenet-core#5924). A contract with bounded
retention (a capped log, a capped member list, anything that evicts) cannot be
strictly associative: a removal or a raised cap can free a slot that only one
grouping refills. That is allowed if the groupings converge. With
`L = merge(merge(A, B), C)`, `R = merge(A, merge(B, C))`, `L != R`, and
`M = merge(L, R)`:

- `merge(R, L)` must equal `M`;
- repeatedly merging `L`, `R`, `A`, `B` and `C` into `M` must reach a state
  that no further merge changes, within a few rounds, and each step must absorb
  re-delivery (`merge(merge(M, X), X) == merge(M, X)`).

A repeated state (a cycle) is a violation. So is an invalid `L` or `R`. Do not
read this as "associativity is optional": a merge whose result keeps moving
(averaging, a counter that climbs on every exchange, last-write-wins on a
wrapping sequence number) still fails. Only the bounded-retention case passes.

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
- **Run removals and caps in one bounded loop to a fixpoint.** When removing
  one record can make another removable (or free a slot under a cap), loop
  until a pass removes nothing. If each pass only shrinks the set, the loop
  terminates in at most `n + 1` passes. Separate one-shot passes in a fixed
  order leave states that a second merge changes again.
- **A greedy cap is safe** when it walks records in a fixed order derived only
  from each record's own content, and each admission reads only the records
  already admitted plus facts the procedure does not change.
- **Normalize held state on every apply.** `validate_state` usually accepts
  states no merge produces (a full-state PUT runs only validation): duplicates,
  records over a cap, records whose dependencies are gone. Run the same
  cleanup over held state on every apply, so every state a merge produces is a
  fixpoint of `merge(S, S)`.

## Deduplicate within one delta

Checking each incoming record against held state is not enough: two
byte-identical copies of a record in the *same* delta both pass a check made
against held state, and the state ends up holding both. The next merge with a
peer holding one copy then differs by direction. Deduplicate the incoming
records among themselves (by full-record bytes or digest) as well as against
what is held. This is the same mistake as the snapshot noted in
`contract-patterns.md` → "Decide What One Bad Entry in a Delta Does".

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

- **Refuse before cryptography, over the incoming state's own signed caps.**
  Count records first and refuse a whole state holding more than its own
  signed configuration allows, before checking any signature. Because
  validation enforces the same caps, a state that `validate_state` accepts is
  never refused by merge.
- **Do not trim whole-state merges.** A trim chooses records before the merged
  state's own removals and caps run, so the two directions of one exchange
  differ. Apply every incoming record and let the canonical procedure decide.
- **A trimmed network delta must make progress every round.** A delta built
  against a summary, without the receiver's state, may be trimmed to a work
  bound, with the rest following in later rounds. Make each trimmed delta
  usable on its own: include the records the kept records depend on (the
  records needed to verify them), so the receiver keeps something every round
  instead of pruning it. Run anything that adds records to the delta before
  the trim. Test that a large backlog converges within a bounded number of
  rounds.

## A validly signed record never makes a merge fail

Return `Err` from a merge only for a forgery (a signature that does not verify)
or an exceeded work bound. A record that is validly signed but that this state
does not admit (over a cap, referencing something unknown, disallowed by the
current configuration) is skipped on arrival and dropped where held, by the
same rule in both places. An `Err` for such a record fails every merge with
any peer holding it, in one direction only, permanently, and only the record's
author can repair it. Also make sure `validate_state` rejects anything a merge
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
  `fdev verify-merge --wasm contract.wasm --state s1.bin --state s2.bin`.
- **Mutation-check the fuzzer.** Move a cap ahead of cleanup, delete a
  dedup, or drop the digest from a summary, and confirm the fuzzer fails. A
  fuzzer that stays green under those changes does not cover them.
