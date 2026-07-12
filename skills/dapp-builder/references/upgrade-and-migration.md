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
   packages them. It is **published on crates.io as v0.1.0**: `cargo add
   freenet-migrate` (runtime carry-forward) and `cargo add --build
   freenet-migrate-build` (build.rs codegen + CI hash-guard). Honest caveat: v0.1.0
   targets stdlib 0.8.x and does the *contract*-side carry-forward; the
   node-mediated transport into a predecessor *delegate* is a documented stub, so
   delegate secret migration still runs the River/Delta way (the app re-runs the
   old delegate WASM over `DelegateRequest::ApplicationMessages`). See
   `contract-patterns.md` and `delegate-patterns.md` for the mechanics it codifies.

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
   five properties" below.

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

Freenet keys are `BLAKE3(code_hash || params)`, so **any** change to contract or
delegate WASM produces a new address. There is no in-place upgrade. An upgrade is
always "deploy a new contract/delegate at a new address and migrate state to it."

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

   // On load:
   if flag_set("migration_in_progress") {
       // partial set -> do NOT mark done; re-run migration (idempotent) to fill gaps
   } else if has_new_format_data() {
       mark_migration_done();              // authoritative; never re-probe old (see #253)
   }
   ```

3. **Non-destructive.** Never delete the source until the destination is
   confirmed complete. Keep the old blob/keys as a rollback fallback so an old or
   rolled-back client still finds data. River intentionally leaves the legacy
   `rooms_data` blob in place after exploding it into per-entity keys.
4. **Regression-gated.** Once the destination is populated it is authoritative;
   never let a stale *source* read overwrite newer *destination* data. River #253:
   firing the legacy probe unconditionally let an old delegate's stale snapshot
   clobber rooms the user created after upgrading. Gate migration on
   "destination is empty," and make conflict resolution merge, not replace.
5. **Observable.** Emit migration telemetry — started / completed / recovered /
   failed counts. River found #352 only because a user reported a vanished room;
   there was no signal that real migrations were failing. A "publish succeeded"
   build metric is not a "users' data migrated" metric. This is the single
   highest-leverage thing most teams skip.

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
  build-time codegen, the backward probe, and the preconditions (published on
  crates.io as v0.1.0 — `cargo add freenet-migrate` /
  `cargo add --build freenet-migrate-build`; prefer it over hand-rolling).
- River as worked reference: freenet/river#345 (per-entity CAS keys), #352
  (resumable/interrupted-migration recovery), #253 (regression-gated legacy probe),
  #204 (old delegate WASM unrunnable after an stdlib bump), #393 (gitignored
  `Cargo.lock` silently re-keying contracts).
