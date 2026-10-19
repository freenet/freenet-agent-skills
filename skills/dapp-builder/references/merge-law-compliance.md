# Merge-Law Compliance

How to build a contract merge that passes the laws freenet-core checks
(freenet-core#5320) and keeps passing them as the contract grows caps,
removals and work bounds. Read `contract-patterns.md` → "Merge Law
Requirements" first for the basic laws and property tests; this file covers
what goes wrong once a merge is more than a plain union.

## Design state so the merge is lawful by construction

The rest of this file is about making a given merge lawful. These rules come
first, because most violations come from how the state is shaped. They do not
remove the need for the checks below: a cap combined with any removal still
needs the heal-guarded form of associativity.

1. **Assume any state `validate_state` accepts can reach your merge.** Why: a
   full-state PUT runs only validation, so peers hand your merge states your
   client never makes. How: state each law over every valid state, and fuzz
   with crafted valid states (duplicates, over-cap sets, records whose
   dependencies are missing), not only states your client produces.
2. **Dependencies point toward authority, and removal cascades down only.**
   Why: if keeping or dropping a record depends on which records below it are
   present, caps and cleanup change the answer, and re-merging a dropped
   dependent changes the result. How: a record may depend only on records
   closer to the authority (owner key -> authors -> their posts -> replies).
   A record may be dropped because something it depends on was dropped, never
   kept or dropped because of what depends on it. Do not drop a record others
   depend on while those dependents remain: drop the dependents first, or drop
   the whole subtree as one unit.
3. **Decide liveness from a record's own fields.** Why: neighbouring records
   come and go with caps and cleanup, so a rule that reads them gives
   different answers on different peers. How: put the fact the rule needs in
   the record itself, signed by its author and merged monotonically (for
   example a `last_active` timestamp merged by max), and read only that.
4. **Bound size with an order fixed when a record is created.** Why: a cap
   that ranks by something fixed at creation never readmits a record it
   dropped, however much more is merged in. How: keep the top N by creation
   timestamp (with a fixed rule for equal timestamps), and cap per author so
   each author's records compete only with each other. A creation timestamp is
   the author's claim, so an author can future-date records to hold top slots;
   the per-author cap limits that to the author's own records. A per-author
   cap bounds total size only if the number of authors is bounded too.
5. **Make further pruning an authority's signed act.** Why: when peers prune
   by local judgement over different sets, they disagree. How: if you need to
   prune beyond per-record caps, have the owner (or another key the parameters
   name) sign a checkpoint stating the cut, for example "drop records older
   than T". The merge keeps the checkpoint with the latest cutoff, so the cut
   only moves forward and every peer applies the same one. The owner must
   never sign two different checkpoints with the same cutoff.
6. **Make every stored record's signature and authorization verifiable from
   its own bytes plus the parameters.** Why: a check that reads other records
   changes its answer as those come and go, and a stored record that is never
   re-verified lets a forgery persist. How: carry any authorization proof in
   the record, root it in the contract parameters, and verify stored records
   by the same rule as arriving ones. Whether a valid record is *kept* may
   still depend on the records it depends on (rule 2).
7. **Accept only states your merge produces.** Why: a valid state that
   `merge(S, S)` rewrites is reported under state idempotence. How: have
   `validate_state` reject any state that the merge's cleanup would change,
   unless an upgrade path needs it to accept states already held on the
   network (see "Merge = one canonical procedure over the union" below). That
   check runs the cleanup, so count it against the work bounds below.
8. **Judge by freenet-core's own verdicts.** Why: a test you wrote against
   your own idea of the laws can pass while the network's verifier reports a
   violation. How: fuzz with crafted states and run `fdev verify-merge` on the
   results, as described under "Testing" below.

**Worked example: inactivity pruning.**

- Bad: drop an author, and their posts, when the posts the state currently
  holds show no recent activity from them. Which posts are held depends on
  the post cap and on what else has arrived, so two peers holding the same
  records can reach different results, and re-merging a dropped post can
  bring its author back.
- Good: each author signs a `last_active` timestamp in their own record,
  merged by max. The owner signs a checkpoint with a cutoff time. The merge
  drops an author whose `last_active` is older than the latest checkpoint
  cutoff, together with everything that depends on that author, as one unit.
  The rule reads one field of the record and one authority fact, neither of
  which depends on what else is present, and it reads no clock.
- Limits of the good version: `last_active` is the author's claim, so an
  author who future-dates it is never pruned this way; the owner needs a
  separate signed removal for that case. The cascade drop is not a
  tombstone: an author who later signs a newer `last_active` comes back, with
  any of their posts a peer still holds. A removal that must stick, such as a
  moderation removal, needs a tombstone (see `state-authorization-patterns.md`
  → "Tombstones").

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
