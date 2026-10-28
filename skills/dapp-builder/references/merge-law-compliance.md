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

1. **Treat everything `validate_state` accepts as input to your merge.** Why:
   freenet-core's verifier checks each law over every state `validate_state`
   accepts, not only over states your clients produce. A PUT to a peer that
   does not yet hold the contract stores the state after validation only,
   without running your merge, and anyone can build valid states offline,
   without any key, by replaying and recombining your contract's public
   records: subsets and unions of records from different histories,
   duplicates, older signed versions of a record. A law failure on such a
   state is a real convergence failure, because the same state can be put on
   the network and honest peers then disagree. Today the verifier runs in
   `fdev verify-merge` and on peers whose operator enables conformance
   capture, and it removes nothing. Separately, every node already runs two
   checks with live consequences: on about one in 32 whole-state merges it
   re-applies the same incoming state to the result (absorption, below), and
   when an incoming state equals the stored one it re-applies it until the
   state stops changing. If either check fails, the node flags the contract,
   and while the flag lasts (it expires, and is persisted across restarts)
   the node stops committing and sending that contract's state. The planned
   enforcement (freenet-core#5320) removes a contract on the peer that
   reproduces a violation (that peer stops hosting it), and that peer
   remembers its id so ordinary traffic does not bring it back. "Our client
   never produces that state" is not a defence. How: state each law over every
   valid state, make `validate_state` reject what your merge cannot handle
   (rule 7), and fuzz with crafted valid states as well as client-produced
   ones (see "Testing").
2. **Dependencies point toward authority, and removal cascades down only.**
   Why: if a record is kept because records that depend on it need it, a cap
   that evicts one of the records a dependent needs also removes the reason to
   keep the others it needs, and the result then depends on which records were
   merged together. Worked example 1 below is a case of this that
   freenet-core reports as a violation. How: a record may depend only on
   records closer to the authority (owner key -> authors -> their posts ->
   replies). A record may be dropped because something it depends on was
   dropped, never kept or dropped because of what depends on it. Never leave a
   dependent without its dependency in the result: the cleanup that drops a
   record also drops its dependents.
3. **Decide liveness from a record's own fields.** Why: the same failure as
   rule 2. When whether a record stays depends on other records that a cap or
   cleanup can remove, one set of records can settle at two different results
   depending on which of them arrived together. How: put the fact the rule
   needs in the record itself, signed by its author and merged monotonically
   (for example a `last_active` timestamp merged by max), and read only that.
4. **Under a cap, rank and admit each record by its own fields.** Why: if a
   cap's order, or its test of which records may take a slot, reads whether
   other records are present, the cleanup that runs after the cap removes some
   of those records, and merging the same input again ranks the records
   differently (worked example 2 below). A cap that ranks by a field fixed
   when the record was created, with no removals, never readmits a record it
   dropped, however much more is merged in. How: keep the top N by creation
   timestamp, with a fixed rule for equal timestamps. A field the author can
   raise later and that merges by max, such as `last_active`, also passed as a
   ranking key in a small exhaustive model. This applies to caps on removal
   records too: rank and admit a ban by the ban record alone (its issuer, its
   time, its signature), never by whether its target or its issuer is present
   in the state. Check the issuer's authority from records kept with the ban
   rather than from whether the issuer's member record is held: unlike the
   author of a message, a ban's issuer can itself be removed by another ban,
   and if that removal changed which bans count, the cap's answer would change
   with it (in a small model this gave absorption failures and cycles;
   carrying the proof with the ban made every case heal).
   Separately, to stop one author crowding out the others, cap per author so
   each author's records compete only with each other. A creation timestamp is
   the author's claim, so an author can future-date records to hold top slots;
   the per-author cap limits that to the author's own records. A cap across
   all authors that ranks by these timestamps is still lawful, but lets one
   author take slots from others by future-dating (see
   `state-authorization-patterns.md` → "A Value One Party Supplies…"). A
   per-author cap bounds total size only if the number of authors is bounded
   too.
5. **Make further pruning an authority's signed act.** This is a design
   sketch: no published contract uses it, and it has been checked only in a
   small exhaustive model, where every associativity failure healed. Why: when
   peers prune by local judgement over different sets, they disagree. How: if
   you need to prune beyond per-record caps, have the owner (or another key
   the parameters name) sign a checkpoint stating the cut, for example "drop
   records older than T". The merge keeps the checkpoint with the latest
   cutoff, so the cut only moves forward and every peer applies the same one.
   If two checkpoints carry the same cutoff, keep the one with the larger
   signature bytes, so the merge gives the same result whichever arrives
   first.
6. **Make every stored record's signature and authorization a fixed
   function of its own bytes, the parameters, and the records it depends on.**
   Why: a check whose answer can change while its inputs stay present gives
   different answers on different peers, and a stored record that is never
   re-verified lets a forgery persist. How:
   - A record may depend on records closer to the authority (rule 2), for
     example a message on its author's member record, which depends on its
     inviter's, up to the owner key in the parameters.
   - Name each dependency by an id derived from a key that never changes, such
     as a hash of the signing key, and to verify a record read only that key
     from the dependency. A field a newer version of the dependency can change,
     such as `last_active`, is for rule 3, which reads it from the record
     itself.
   - If one id can have several valid records, first combine the versions the
     field rules merge (for example `last_active` by max). Among records that
     still differ (for example different inviters), choose by a rule over each
     record's own bytes, such as the lowest digest, and verify dependents
     against that one. Never let arrival order choose.
   - Bound the walk to the authority: detect cycles, cap the depth, and verify
     each record's signature once per merge, sharing the result across the
     records that depend on it (see "Work bounds" below).
   - Drop a record whose dependency is absent or fails verification. Do this
     inside the one canonical cleanup, looped to a fixpoint (see "Merge = one
     canonical procedure over the union"), never in a separate pass. A later
     merge that carries the dependency and its dependents restores both; a
     removal that must not come back needs a tombstone (see the inactivity
     example below).
   - When `update_state` applies a delta, a record whose dependency is absent
     is skipped, never a reason to return `Err`. `validate_state` rejects a
     whole state that still holds such a record, because the cleanup would
     change it (rule 7), and the merge may refuse such an incoming whole state
     (see "A validly signed record never makes a merge fail").
   - Verify stored records by the same rule as arriving ones.
7. **Accept only states your merge produces.** Why: a valid state that
   `merge(S, S)` rewrites is reported under state idempotence. How: have
   `validate_state` reject any state that the merge's cleanup would change.
   If an upgrade path forces you to accept states already held on the
   network, every such state remains a violation that anyone can submit, so
   treat that as temporary and close it at the next re-key. The check runs the
   cleanup, so count it against the work bounds below.
8. **Judge by freenet-core's own verdicts.** Why: a test you wrote against
   your own idea of the laws can pass while the network's verifier reports a
   violation. How: fuzz with crafted states and run `fdev verify-merge` on the
   results, as described under "Testing" below.

**Worked example 1: a member kept only because other records need it.**
Members are m0 to m3. A member cap of 2 keeps the two members with the
smallest index, and the merge keeps a member only while a post or a direct
message held in the state needs them. Three valid states:

- A: m3, and a post by m3.
- B: m0 and m3, and a direct message between them.
- C: m1 and m2, and a direct message between them.

`merge(B, C)` needs all four members. The cap keeps m0 and m1 and evicts m2
and m3, so each direct message loses a participant and is dropped, and then
nothing needs m0 or m1, so they are dropped too. The result holds no members,
and `merge(A, merge(B, C))` is A. `merge(merge(A, B), C)` ends with no
members in the same way. The two groupings differ, and when the verifier
merges them and re-delivers an input, the merged state changes again, which it
reports as a violation. Keep the member by a field of its own record instead
(rule 3), drop a post or a message when a participant is absent, and the same
shape passes.

**Worked example 2: a ban cap that reads which members are present.** A cap
keeps one ban. Ban x (newer) removes member u, and ban y (older) removes
member t; both are issued by a member whose authority each
state can check. The cap ranks a ban whose target is present ahead of one
whose target is absent, and otherwise newer first. A holds t, B holds x, and
C holds y.

- `merge(merge(A, B), C)`: t is present, so y ranks first and is kept, and t
  is removed. The result holds y alone.
- `merge(A, merge(B, C))`: neither target is present in `merge(B, C)`, so the
  newer ban x is kept. Adding A gives t and x.

Merging these two results and the inputs into each other repeatedly returns to
a state already seen, which the verifier reports as a cycle. Ranking by the
ban record alone, newest first, makes every grouping in this example converge.

**Worked example 3: inactivity pruning.**

- Bad: keep an author only while a post, a direct message or another record
  held in the state needs them. Once a member cap applies and a record needs
  two members (a direct message), this is worked example 1.
- Good: each author signs a `last_active` timestamp in their own record,
  merged by max. The owner signs a checkpoint with a cutoff time (rule 5, a
  sketch). The merge drops an author whose `last_active` is older than the
  latest checkpoint cutoff, together with everything that depends on that
  author, as one unit. The rule reads one field of the record and one
  authority fact, neither of which depends on what else is present, and it
  reads no clock.
- Limits of the good version: `last_active` is the author's claim, so an
  author who future-dates it is never pruned this way; the owner needs a
  separate signed removal for that case. The cascade drop is not a
  tombstone: an author who later signs a newer `last_active` comes back, with
  any of their posts a peer still holds. A removal that must stick, such as a
  moderation removal, needs a tombstone (see `state-authorization-patterns.md`
  → "Tombstones").

**Design choices this file does not settle.** A chat-style contract has to
decide each of these. Where a choice was checked, the check was a small
exhaustive model using the verifier's heal rule, not a deployed contract.

- **Who may issue a ban, and whether a ban outlives its issuer.** Rule 4 has a
  ban carry the proof of its issuer's authority. Which members may ban which
  (for example only the owner, or only a member above the target in the invite
  chain), whether a ban stays in force after its issuer is removed, and how to
  treat two members banning each other are policy choices that were not
  modelled here.
- **A capped ban list is not a lasting removal.** A cap keeps at most N bans,
  so admitting one more evicts a held ban, and the evicted ban's target can
  return from any peer that still holds the target's record. If a removal must
  last, it needs a record that no cap evicts, and then the state's size is not
  bounded by that cap; this file does not give a lawful way to bound it. The
  bounded tombstone list in `state-authorization-patterns.md` → "Tombstones"
  evicts its oldest entries, so it has the same limit. Otherwise accept that a
  banned member can return after their ban is evicted.
- **Whether removing an inviter removes the members they invited.** Under rule
  6 a member record depends on its inviter's record, so pruning or banning an
  inviter drops every member they invited, active or not. The alternatives are
  to accept that, or to make a member record independent of its inviter's
  stored record, for example by carrying the signed invite chain in the member
  record itself. The second was not modelled here.
- **The order of caps across layers.** For members kept by their own records
  (rule 3) and messages: cap the members, drop messages whose author is no
  longer a member, then cap the messages over the ones left. In the model this
  order gave no absorption failures and every associativity failure healed,
  with and without uncapped owner bans. It is not strictly associative even
  without bans, because evicting a member frees message slots, so a fuzzer
  must check the heal-guarded form. Capping the messages first, over every
  held message, and then dropping orphans gave cycles and absorption failures.
- **Which members a member cap keeps.** Keeping the earliest members refuses
  new members once the cap is reached; keeping the newest lets new members
  evict existing ones; ranking by `last_active` merged by max evicts the least
  recently active member, and a member who future-dates `last_active` keeps a
  slot, which is the cross-party ranking `state-authorization-patterns.md` →
  "A Value One Party Supplies…" warns against: lawful, but open to that abuse.
  In the model, ranking by a fixed creation order and ranking by
  `last_active` both healed every associativity failure. Whether to cap
  members per inviter, and how to bound the number of inviters, was not
  modelled.
- **Configuration changes.** When an owner-signed configuration sets a cap,
  use the newest configuration, with a fixed tie-break for equal versions.
  Lowering a cap evicts records; raising it lets records that other peers still
  hold come back on a later merge, which is the case heal-guarded
  associativity allows.

## The laws, as the network checks them

All comparisons are on exact bytes. `fdev verify-merge` runs the same checks
as the network's verifier; only Violation-severity laws can lead to a
contract's removal under the planned enforcement. The state laws (idempotence,
commutativity, associativity, emitted state validity, determinism, path
agreement, reconciliation) must hold for every state `validate_state` accepts,
wherever that state came from: the verifier re-runs the case itself and does
not ask who built the inputs. Delta order and transition path agreement are
judged only on history a peer observed itself (deltas computed against the
same base, an observed `base -> result` step).
For valid states `A`, `B`, `C` and a delta `D`:

| Law | Statement | Severity |
|---|---|---|
| State idempotence | `merge(A, A) == A` | Violation |
| State commutativity | `merge(A, B) == merge(B, A)` | Violation |
| State associativity | `merge(merge(A, B), C) == merge(A, merge(B, C))`, or the heal-guarded form below | Violation |
| Emitted state validity | every state `update_state` emits passes `validate_state` | Violation |
| Determinism | update, summary and delta give the same bytes for the same inputs | Violation |
| Delta order | two deltas computed against the same base reach the same state in either order | Violation |
| Path agreement | applying `get_state_delta(B, summarize(A))` to `A` equals merging the whole state `B` into `A`, or merging `B` into that result repairs the difference (not checked when the delta is empty or too large to send) | Violation |
| Transition path agreement | for an observed step `base -> result`, `merge(base, result) == result`, with `result` first merged with itself until it stops changing | Violation |
| Reconciliation | two valid divergent states reconcile through summary and delta rounds instead of cycling | Violation |
| Delta idempotence | `apply(apply(A, D), D) == apply(A, D)` | Diagnostic |

Delta idempotence is reported but cannot cause removal: whether contracts may
rely on deltas that are not idempotent (counters, append logs) is still an
open question in freenet-core, and the verifier never validates delta bytes,
so a finding on attacker-chosen deltas must not count. Aim for it anyway:
delivery is at-least-once.

**Absorption**, `merge(merge(A, B), B) == merge(A, B)`, follows from strict
associativity and idempotence, and is the one most cap and cleanup designs
break. The verifier checks it inside the associativity heal step, and every
node already samples it on live whole-state merges and stops propagating a
contract that fails it (rule 1). Test it directly in your own fuzzer.

**Heal-guarded associativity** (freenet-core#5924, in freenet-core v0.2.147
and later; fdev 0.3.309 requires that release, and an fdev built against an
earlier freenet release checks strict associativity). A contract whose cap or
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
that keeps the top N records by each record's own content, with no removals,
a fixed N, and a `validate_state` that rejects more than N records, is
strictly associative and needs none of this.

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
  a record once admitted. This gives idempotence and absorption. When
  admitting one record can block another, the two groupings can still differ,
  and they then need the heal check above.
- **Otherwise run removals and caps in one bounded loop to a fixpoint.** When
  removing one record can make another removable (or free a slot under a cap),
  loop until a pass removes nothing. If each pass only shrinks the set, the
  loop terminates in at most `n + 1` passes. Separate one-shot passes in a
  fixed order leave states that a second merge changes again. The loop is
  necessary but not sufficient: if more than one fixpoint exists, the result
  depends on the starting set and absorption still fails.
- **Normalize held state on every apply.** `validate_state` usually accepts
  states no merge produces (a PUT to a peer that does not hold the contract
  stores the state after validation only): duplicates,
  records over a cap, records whose dependencies are gone. Run the same
  cleanup over held state on every apply, so every state a merge produces is a
  fixpoint of `merge(S, S)`. Normalizing held state does not make a valid
  non-fixpoint state acceptable: it is still reported under state idempotence
  when anyone submits it, so `validate_state` must also reject states cleanup
  would change (rule 7).

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
merge only for an exceeded work bound or an incoming whole state that
`validate_state` rejects (for example one holding a signature that does not
verify, or a record whose dependency is absent). Inside a delta, skip a record
whose signature does not verify or whose dependency is absent, and apply the
rest: refusing the whole delta also refuses every valid record that
travels with it (see `contract-patterns.md` → "Decide What One Bad Entry in a
Delta Does"). A record that is validly signed but that this state
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
  versions, records in a non-canonical order, subsets and unions of records
  taken from different histories, older signed versions of a record), and
  check idempotence, commutativity, absorption, heal-guarded associativity,
  and apply-twice equals apply-once for deltas. Feed raw generated states to
  the laws as well as merge outputs: the network checks raw valid states.
- **Fork tests across many seeds.** Grow two forks from a common ancestor with
  random operations, exchange states and deltas, and require convergence, a
  commutative first exchange, and a `merge(S, S)` fixpoint after every apply.
  A small default seed count is a smoke test; run a large count (River's
  `common/tests/fork_merge_closure_test.rs` reads `FORK_SEEDS`; run it with
  `FORK_SEEDS=1000`) before
  merging a merge change, because some defects appear only there.
- **Real states as fixpoints.** Capture real states and check each is a
  fixpoint of `merge(S, S)` and that pairs commute. Run `fdev verify-merge`
  (the same verifier the network runs, previously `fdev conformance`) on them:
  `fdev verify-merge --wasm contract.wasm --params params.bin --state s1.bin
  --state s2.bin`. Without `--params`, fdev uses empty parameters; a contract
  whose parameters do not decode from empty bytes, or fail its checks, then
  rejects or fails on every state, every case comes back inconclusive, and the
  command still exits 0, so count the cases that held. Pass observed steps
  with `--transition BASE RESULT`, without which transition path agreement is
  not checked. BASE is the state the peer held and RESULT the state it
  reached; supplied the other way round, a conforming contract is reported as
  violating the law. With `--state` files it cannot check a contract that
  needs related contracts (see `SKILL.md`).
- **Mutation-check the fuzzer.** Move a cap ahead of cleanup, delete a
  dedup, or drop the digest from a summary, and confirm the fuzzer fails. A
  fuzzer that stays green under those changes does not cover them.
- **Measure whether the generated states reach every branch.** A passing
  fuzzer does not show that its crafted states ever hit the cap path, the
  overflow rule or a given filter arm. Run the fuzzer and unit tests under
  branch coverage (`cargo llvm-cov --branch`, currently nightly-only) on the
  host build of `update_state`, `validate_state`, `summarize_state`,
  `get_state_delta` and the filters, caps and pruning they call, and fail CI
  when one of those branches is never visited, unless it is listed with a
  reason. Coverage shows a branch was reached, not that its result was
  checked; pair it with mutation.
- **Add an automated mutation tool, and read what it misses.** Run
  `cargo-mutants` on the same functions and review every missed mutant. One in
  cfg-gated code, or in a function no test calls, says nothing about your
  assertions; check its diff. Unviable and timed-out mutants are separate
  outcomes, not kills. These tools mostly replace function bodies and flip
  operators, which is the weakest kind of mutation (see `contract-patterns.md`
  → "Tests That Would Have Caught It"), so keep the hand-written
  wrong-but-plausible mutations as permanent tests alongside them.
