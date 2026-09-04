# Upgrading Contracts and Delegates Safely

This is the hub for upgrading a live Freenet dApp. The **painless-path playbook**
below is the start-to-finish procedure; the rest of the document is the
operational discipline behind it (the five properties that keep a migration from
losing data, the test harness, and rollout mechanics). The per-component
*mechanics* live in `contract-patterns.md` ("Contract WASM Upgrade & State
Migration") and `delegate-patterns.md` ("Delegate WASM Upgrade & Secret
Migration"), which the playbook links to. Every lesson here was paid for in
production by River (freenet/river#345, #352, #253, #204, #393). Read it before
your *second* release, and design for it before your *first*.

## Upgrading a Freenet dApp — the painless path

**If you are here to upgrade an existing dApp — bump `freenet-stdlib`, ship a new
contract or delegate version, or fix a bug that changes the WASM — start here.**

A routine WASM/stdlib bump is **low-risk and mechanical when you designed for it
at v1.** It is NOT "recreate everything and all invites die." River's live 0.6→0.8
stdlib re-key (verified 2026-07-12) migrated every room on the next refresh, kept
every invite and share link working, and left the 78-member Official room intact —
with no recreation. The property that makes this work: the contract key moves on
any WASM change, but your app's durable references were anchored to a **stable
identifier that does not move with the WASM** (River's rooms anchor on the owner's
verifying key; other designs use a fixed namespace, a DID, or an index contract —
see step 1), so clients re-derive the new contract key and every reference keeps
pointing at the right place.

The whole procedure, start to finish:

1. **(Design precondition — done once at v1; verify it still holds.) Choose a
   stable identity anchor that is independent of the WASM; never expose the raw
   content-addressed contract key as your app's identity.** A WASM / dependency /
   compiler change re-derives the contract key, so any durable reference that
   hard-codes it — invites, share links, bookmarks, membership records,
   external-service keys, index/registry entries, anything users or other systems
   hold onto — breaks on upgrade. Anchor those references on something that does
   **not** change when the WASM re-keys, and keep a way to locate/migrate state
   from the old key to the new one (steps 3–5). What the stable anchor *is* depends
   on your app's design — pick one that fits:
   - a **user/owner public key** — *e.g. River*: invites embed the room owner's
     verifying key, and the client re-derives the room contract key from it. Fits
     apps that have a natural owner or per-user identity; not every app does.
   - a **fixed, well-known parameter / namespace / name** — a "singleton" contract
     whose params are stable, so its address only moves when the WASM does (and the
     carry-forward in steps 3–5 handles that move).
   - a **DID or other external identifier** your app already trusts.
   - an **index/registry contract** mapping a stable name → the current contract
     key — a level of indirection. (The index contract itself needs this same
     treatment: its own address must be reachable via a stable anchor.)
   - an **ecosystem-standard pointer contract** — a shared, frozen "pointer"
     WASM at a derivable address `(author_vk, app_id)`, whose state is an
     author-signed `{version, code_hash, sig}` naming the current code hash of
     *some other* contract or delegate. The record format is settled
     (freenet-core#5194; governance questions — author-key rotation and
     recovery, whether adoption is mandatory — are still open), and the contract
     is merged as an in-repo crate (freenet-migrate#9, deliberately unpublished
     *as a crate*; the frozen, CI-hash-checked WASM artifact is the
     deliverable). A client resolver ships in `freenet-migrate` 0.6.0
     (`freenet_migrate::pointer`) — earlier revisions of this file said no
     resolver existed, and that is out of date. Adoption is a separate question
     from availability, and it is thin: publishing a pointer is worth doing for
     your integrators, but do not assume the apps *you* depend on have one.

     Two things to keep straight. It solves **addressing only**: it says nothing
     about whether state or secrets held under the old key survived, and
     assuming they did produces a bug shaped like "this user has no data". And
     it is a different mechanism from the in-state `OptionalUpgrade` pointer in
     `contract-patterns.md`, which is per-instance and only findable by clients
     that already hold a reference to *that* contract; the pointer contract is
     for a third party with no prior reference at all.

     Publishing one is the author-side half. The consumer-side half — resolving
     a pointer for an app you do **not** own, and the three things integrators
     get wrong — is `building-on-other-apps.md`. Check freenet-core#2776 for
     live adoption status.

   If v1 exposed a raw contract key as an identifier, fix *that* first — an upgrade
   cannot rescue an identifier that moves with the WASM. See
   `identity-and-addressing.md` and "Architecture invariants" below.

2. **Make the build reproducible, so the key moves only when you mean it to.**
   Commit `Cargo.lock`, pin the toolchain (`rust-toolchain.toml`), build
   `--locked`. Otherwise a stray `cargo update` or a different rustc silently
   re-keys the contract and orphans data with no upgrade in sight (River's
   `Cargo.lock` was gitignored — freenet/river#393). See `build-system.md` →
   "Byte-reproducibility" and "Hash + artifact hygiene" below.

3. **BEFORE you change the WASM, register the *outgoing* code hash in the legacy
   registry.** This is the one required operational step and the single most
   commonly forgotten one. Record the hash the *current* release ships — while it
   is still the committed WASM — so the new client can find and carry state forward
   from it. River does this with `cargo make add-migration` (delegate) and
   `cargo make add-room-contract-migration` (room contract), which append the old
   `code_hash`/key to `legacy_delegates.toml` / `common/legacy_room_contracts.toml`
   *before* the new WASM is committed; a pre-commit hook plus the `check-migration`
   / `check-room-contract-migration` CI tasks block any WASM change that skips it.
   Your app builds the equivalent registry + guard, or gets both from
   `freenet-migrate` (next step). Order matters: register first, then rebuild.

4. **Use the `freenet-migrate` crate for the carry-forward instead of hand-rolling
   it.** The legacy-hash registry, the `build.rs` codegen, the backward probe, and
   the preconditions-as-types are identical across every app, so `freenet-migrate`
   packages them. It is **`freenet-migrate` 0.6.0 on crates.io** (with
   `freenet-migrate-build` 0.2.0): `cargo add freenet-migrate` (runtime
   carry-forward) and `cargo add --build freenet-migrate-build` (build.rs codegen +
   CI hash-guard). This is the mechanism River's contract-migration path runs in
   production: the browser UI and `riverctl` both drive it live, and River adopted
   it without a rewrite, its build codegen reading the existing `[[entry]]`
   registries and emitting view consts that match the hand-rolled shapes
   (freenet/river#434, #436, #437). Honest caveat: the crate's field-deployed path
   is the *contract* side. A node-level delegate-secret copy-forward was
   designed and shipped (`RegisterDelegateWithPredecessors`, freenet-core#4908)
   — then found forgeable and disabled as a security fix (freenet-core#5199:
   predecessor delegate keys are publicly derivable, so there was no sound way
   to verify a client's claim to own a predecessor's secrets), and the wire
   variant was removed from freenet-stdlib `main` (freenet-stdlib#91, version
   bumped to 0.9.0, **unreleased as of 2026-08-09** — crates.io's latest is
   0.8.5, which still carries the variant; nodes are protected by #5199's
   disable, not the removal). **There is no core mechanism for delegate secret
   migration and there will not be one**: three trust-model designs have been
   tried and rejected, and the settled standing policy (freenet-core#2776,
   2026-08-09) is that delegate secret migration happens at the app level
   permanently, not as an interim measure. That does not mean bespoke per app:
   `freenet-migrate` ships the delegate-side entry points
   (`migrate_delegate_secrets`, `register_delegate_with_migration`, unchanged
   since 0.5.0), and River, Delta and ghostkeys all drive them on `main` at
   0.5.0. See `delegate-patterns.md` →
   "Delegate secret migration: no core mechanism, and why" for the full history
   and current guidance, and `contract-patterns.md` for the contract-side
   mechanics. For the procedure of swapping an existing hand-rolled sweep over
   to the crate, see the `freenet-migrate-adoption` skill.

5. **Publish the new version, then let clients migrate themselves.** Publish the
   new WASM to the shared production key **from `main` only**, after review and
   green CI (every publish hits the same shared address). Each client, on its
   **next load**, computes old-key vs new-key, GETs the old state, and re-PUTs it
   under the new key — the successor's `validate_state` re-verifies every byte, so
   *any* client can carry the state forward and the owner need not be online.
   Migration is **per-client, lazily, on next load**; old and new clients coexist
   for an unbounded rollout window. A **fresh device has no local state to
   migrate** — that is normal, not a failure. Keep the migration itself safe
   (idempotent, resumable, non-destructive, regression-gated, observable) per "The
   five properties" below, and make sure nothing in your load path writes to the
   new key before the probe runs — a placeholder or default seeded first is what
   the fold then merges against, and any app that (wrongly) gates on the
   destination being empty is silently disabled by it outright. See "Probe before
   you write to the new key".

6. **Do NOT recreate instances, rotate keys, or warn users their invites are
   dead.** None of that is part of a routine upgrade, and doing it *causes* the
   loss you were trying to avoid. Recreation — a genuinely new contract instance and
   fresh references — is **only** for a deliberate change of the app's *identity
   anchor* itself (e.g. rotating a compromised owner key, or standing up a genuinely
   separate instance), never for a contract or stdlib bump.

**What makes it painless is two things holding together:** (1) a stable identity
anchor independent of the WASM (step 1) so references survive the re-key, and
(2) state the successor can carry forward on its own. The second means either **self-authorizing + backward-compatible state**
(so any client can re-PUT it and the new `validate_state` accepts it), OR a
**written carry-forward** via `freenet-migrate` / the backward probe. With those in
place the steps above are mechanical. Without them an upgrade is genuinely risky —
so the fix is to add them, not to recreate everything. The honest caveats stand:
migration is per-client on next load, and a fresh device has no local state to
carry forward.

## The one truth that shapes everything

Freenet keys are `BLAKE3(code_hash || params)`, so **any change to contract or
delegate WASM produces a new address**. For a WASM change there is no in-place
upgrade: it is always "deploy at a new address and migrate state to it."

**Scope this correctly — it is about WASM, not about content.** Changing a
contract's *state* is an ordinary update at an unchanged address, and that is a
first-class upgrade path, not a loophole:

- **Your webapp is state.** Shipping a new UI build is an in-place update of a
  web container contract at a permanent URL. It re-keys nothing, and needs no
  migration and no redirect contract. See `web-container-contract.md`.
- **This whole document is about the other case** — your data contracts and
  delegates, where the WASM itself changes and state has to be carried forward.

Everything below applies to the WASM-change case.

Therefore **the entire risk surface of an upgrade is the migration.** Don't aim
for "risk-free upgrades" (impossible); aim for migrations that are *idempotent,
resumable, non-destructive, regression-gated, and observable*. The five
properties below are the whole game.

## Architecture invariants (decide these before v1 — you cannot bolt them on)

1. **Fully self-authorized state.** If every piece of state carries its own
   signature chaining to an authority, *any* node can GET old-key state and PUT
   it to the new key, and the new contract validates it from the bytes alone —
   migration is permissionless and needs no owner online. The cost: you may never
   accept unauthorized state "temporarily," or you forfeit this. See
   `state-authorization-patterns.md`.
2. **Backwards/forwards-compatible serialization.** The same bytes must validate
   under old and new WASM during the rollout window. Additive-only
   (`#[serde(default)]`), never remove/rename/repurpose a field, version-tag when
   you must break, and pin the wire format with round-trip tests.
3. **Shard mutable storage by unit-of-concurrent-change, and use compare-and-swap,
   never blind overwrite.** River #345 stored the whole room list as one blob
   overwritten last-writer-wins; two browser tabs clobbered each other. The fix
   was one key per entity (`room:<id>`), each independently versioned, written via
   read-merge-CAS. Any store with multiple writers (tabs, devices, background
   tasks) needs this. The stdlib delegate API is plain `get_secret`/`set_secret`
   today, so you implement versioning/CAS as request types your delegate handles
   (see River's `GetVersionedRequest`/`CasStoreRequest` in
   `common/src/chat_delegate.rs`).
4. **Partition for bounded blast radius.** River keeps room *state* on contracts
   and signing keys under *separate* delegate keys, so a delegate-migration bug
   degrades to "rejoin via invite," not permanent loss. Design so one migration
   failure can't destroy everything.

## The five properties of a safe migration

1. **Idempotent.** Re-running the migration must be a no-op for already-migrated
   entities. CAS read-merge-write gives you this for free: re-migrating a present
   entity merges (CRDT union) instead of clobbering.
2. **Resumable / self-healing.** This is the #352 lesson. A migration that writes
   N keys one at a time can be cut short (a write fails, the tab closes), leaving
   a *partial* set. If the next load treats a partial set as complete, it strands
   the unwritten entities forever. Guard with a **persistent "migration in
   progress" marker, set before the first write and cleared only on FULL
   success**; on load, if the marker is still set, re-run the migration.

   ```rust
   // On migration start (before the first per-entity write):
   set_flag("migration_in_progress");      // a localStorage / delegate key,
                                           // namespaced per source-version set
   // ... write each entity via CAS ...
   // ONLY after every entity is written:
   clear_flag("migration_in_progress");
   mark_migration_done();
   // On Err / interruption: leave the flag set -> next load re-runs and recovers.

   // On load, keyed per (instance, current_code_hash):
   if flag_set("migration_in_progress") {
       run_migration();                    // partial set -> re-run (idempotent) to fill gaps
   } else if !migration_done(instance, current_code_hash) {
       run_migration();                    // UNCONDITIONAL. Not gated on whether the
                                           // destination already holds data -- see
                                           // property 4 and the trigger rule below.
   }
   ```

   `mark_migration_done()` is reached only from the success path above, on a
   definitive probe outcome. Never seal it because the destination *looks*
   populated: that is the empty-destination gate in disguise, and any earlier
   write then makes the migration permanently unreachable.

3. **Non-destructive.** Never delete the source until the destination is
   confirmed complete. Keep the old blob/keys as a rollback fallback so an old or
   rolled-back client still finds data. River intentionally leaves the legacy
   `rooms_data` blob in place after exploding it into per-entity keys.
4. **Regression-gated.** Once the destination is populated it is authoritative;
   never let a stale *source* read overwrite newer *destination* data. River #253:
   firing the legacy probe unconditionally let an old delegate's stale snapshot
   clobber rooms the user created after upgrading. The fix is in the *resolution*,
   not the trigger: make conflict resolution merge rather than replace, and seed the
   probe from the client's own snapshot so a stale source can only ever add. **Do
   not gate the probe on "destination is empty"** — that is the shape that lost
   River's rooms; see the `freenet-app-migration` skill for the rule.
5. **Observable.** Emit migration telemetry — started / completed / recovered /
   failed counts. River found #352 only because a user reported a vanished room;
   there was no signal that real migrations were failing. A "publish succeeded"
   build metric is not a "users' data migrated" metric. This is the single
   highest-leverage thing most teams skip.

## Probe before you write to the new key

**Run the probe before anything writes to the new key**, and pin the *outcome* —
did the predecessor's history arrive — never the presence of the call. A
source-scrape pin asserting the probe "is called" was green for three months in
River over a call that was unreachable for a whole class of room
([freenet/river#621](https://github.com/freenet/river/issues/621)); existence is not
reachability.

**Audit your own app for it.** Write down the exact condition under which your
migration does *not* run, then grep every write to the new key that can execute
before the probe and confirm none of them can make that condition true. River's
probe fired only when a GET on the current key returned state whose configuration
signature failed to verify — and an earlier block in the same pass PUT a
delegate-cached snapshot exactly when that signature *verified*, so every state
qualifying for the PUT was by construction one that suppressed the probe. Same
predicate, same bytes, unreachable since it shipped, across seven room-contract
re-keys.

The trigger rule this discipline serves — probe unconditionally per
`(instance, current_code_hash)`, gate only the repeat on a durable marker, never gate
the first run on the successor being empty — belongs to the `freenet-app-migration`
skill, along with the River #621 post-mortem and the reference implementation. Read
it before designing the trigger; this file covers what the migration must do once
it fires.

## Enumerate dynamic key families

If your storage has open-ended key families (one key per entity), a *fixed* list
of keys to probe cannot find them — you need a **list/enumerate** operation on the
old store. River's first per-entity migration would have stranded every room on
the *next* delegate rebuild without a `ListRequest` probe of the legacy delegate.
Rule of thumb: fixed single keys (e.g. a settings blob) can be migrated from a
hardcoded list; dynamic families (`room:<id>`, `profile:<id>`) must be discovered
by enumeration.

## Coupled artifacts must move together

Any two artifacts that *independently* derive the same key from embedded WASM must
be published in lockstep. River's UI and its CLI both derive the room-contract key
from a bundled WASM copy; updating one without the other silently sent messages to
a dead key. Add a CI check that fails if the embedded WASM in one artifact differs
from the other.

## Test the upgrade path, not just the new version

The dangerous inputs are **old-state -> new-code** and **interrupted migration** —
neither is exercised by testing the new version on fresh state. Every schema or
key change needs two tests:

1. **Old-format load.** Construct real old-format bytes (or a captured fixture),
   load them with the new code, assert no entity is lost and the format is
   upgraded.
2. **Interrupted-migration recovery.** Simulate a partial migration (write some
   entities, set the in-progress flag, skip the rest), then run the load path and
   assert the missing entities are recovered and the flag clears.

Make this testable by extracting the *decision* (mark-done vs. re-run, given the
in-progress flag) into a **pure function** with a truth-table unit test, rather
than burying it in async load code. River's `decide_per_room_load_action(bool)` is
this pattern; its earlier source-pin-only test had a false positive (it passed
even with the recovery call deleted), so prefer a pure-function behavioral test
and verify by mutation that removing the fix fails the test.

**Three questions worth asking of any migration change in review.** Each names a
failure a green test suite let through.

1. **Does the guard at a seam check BOTH sides of the seam?** A guard that can
   only see the side it lives on is not a guard. `freenet-migrate`'s newest-wins
   guarantee is the canonical shape: the crate offers predecessors newest-first,
   but only the app's writer can see whether the successor already holds a key, so
   an overwriting writer inverts the guarantee and neither side reports it. When
   you find a check at a boundary, name what the other side would have to do to
   defeat it, then confirm something checks that too.
2. **Is the test double above or below the bug you care about?** A double placed
   above the layer that can fail proves only that the layers above it agree with
   each other. `freenet-migrate`'s own tests all drive mocked I/O, with no
   integration test against a real node or a real WASM delegate, which is why
   ghostkeys and Delta each gated adoption on a differential test against their
   prior hand-rolled sweep rather than on the crate's green suite. Put the double
   below the code under test, or test against the real thing.
3. **Is the operation idempotent with respect to the UI as well as to stored
   data?** These are separate properties, and the second is the one that gets
   missed. Delta's editor bug (freenet/delta#62, fixed in #64) is the shape: the
   background migration sweep's merge was a genuine no-op for stored data, but it
   still took the write guard, and Dioxus notifies subscribers on every `write()`
   whether or not the value changed, so an effect subscribed to that signal
   re-seeded the editor from persisted state and wiped the user's unsaved typing
   about five seconds in. Storage idempotence did not save it. Ask what a re-run
   *renders*, not only what it stores.

## Staged, reversible rollout

1. Publish the new version to an **isolated key** (a throwaway contract/params)
   first; validate against a test node.
2. Publish to the **shared production key from `main` only**, after review and
   green CI on the exact commit. Every production publish hits the same shared
   address — a feature-branch publish silently ships stale or unreviewed code.
3. Keep the previous artifact for **rollback**, and expect **old and new clients
   to coexist** for an unbounded window (clients refresh lazily). Versioned
   coexistence is the normal state during a rollout, not an edge case.

## Hash + artifact hygiene (cheap mistakes that lost rooms)

- Key derivation is **BLAKE3, not SHA256** (River lost rooms to a SHA256
  migration entry). `code_hash = BLAKE3(wasm)`, `key = BLAKE3(code_hash ||
  params)`.
- WASM builds are **non-reproducible** — treat a committed WASM as a frozen
  artifact. Never `git add -A`/`-u`/`.` in a repo that commits WASM; a stray
  rebuilt binary shifts the key and orphans user data. Add files by name.
- Make it **impossible to ship a key change silently**: a CI check that fails
  when the built WASM's hash isn't recorded in your `legacy_*.toml` registry
  (River's `check-delegate-migration` / `check-room-contract-migration`).

## References

- `references/web-container-contract.md` — the *other* upgrade path: shipping a
  new UI is an in-place state update at a permanent URL, with no re-key and no
  migration. Read it before assuming a release rotates anything.
- `references/contract-patterns.md` — contract upgrade mechanics: the shipped
  backward-probe baseline (reconstruct old keys from a committed
  `legacy_contracts.toml` registry, GET old state, re-PUT under the current key),
  the optional in-state `OptionalUpgrade` straggler pointer, and the preconditions.
- `references/delegate-patterns.md` — delegate migration mechanics: the backward
  probe that re-runs the old delegate's WASM via `DelegateRequest::ApplicationMessages`
  (there is **no `ExportSecrets` handler**), `legacy_delegates.toml`, the fragility
  when an stdlib/ABI bump strands old WASM, and the double-hashing bug.
- `references/build-system.md` — byte-reproducibility (commit `Cargo.lock`, pin the
  toolchain, build `--locked`; and the `wasm-opt`/`dx`/path-embedding and
  build-command caveats that the lockfile alone doesn't cover).
- `references/state-authorization-patterns.md` — self-authorizing state, the
  precondition for permissionless migration.
- The reusable `freenet/freenet-migrate` crate packages the registry, the
  build-time codegen, the backward probe, and the preconditions (`freenet-migrate`
  0.6.0 / `freenet-migrate-build` 0.2.0 on crates.io; `cargo add freenet-migrate` /
  `cargo add --build freenet-migrate-build`). River's contract-migration path (UI
  and `riverctl`) runs it in production, and existing apps adopt it without a
  rewrite via the `[[entry]]`-registry build codegen (freenet/river#434, #436, #437).
- The `freenet-migrate-adoption` skill: the procedure for swapping an app's
  existing hand-rolled sweep over to the crate (call-site swap, dual-running,
  the parity test, what rollback cannot undo).
- River as worked reference: freenet/river#345 (per-entity CAS keys), #352
  (resumable/interrupted-migration recovery), #253 (regression-gated legacy probe),
  #204 (old delegate WASM unrunnable after an stdlib bump), #393 (gitignored
  `Cargo.lock` silently re-keying contracts).
- [freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776) is
  the live-maintained home base for all three migration problems (addressing /
  pointer contract, contract-state migration, delegate-secret migration) across
  every app the team manages. Check it before assuming anything in this
  document is current — it is the canonical source and will outlive any status
  claim written here.
