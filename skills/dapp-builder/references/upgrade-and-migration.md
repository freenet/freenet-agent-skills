# Upgrading Contracts and Delegates Safely

The *mechanics* of an upgrade — where the new version lives, how to register old
WASM hashes — are in `contract-patterns.md` ("Contract WASM Upgrade & State
Migration") and `delegate-patterns.md` ("Delegate WASM Upgrade & Secret
Migration"). This document is the **operational discipline** that keeps the
migration itself from losing user data. Every lesson here was paid for in
production by River (freenet/river#345, #352, #253). Read it before your *second*
release, and design for it before your *first*.

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
  build-time codegen, the backward probe, and the preconditions (not yet on
  crates.io — prefer it over hand-rolling once it lands).
- River as worked reference: freenet/river#345 (per-entity CAS keys), #352
  (resumable/interrupted-migration recovery), #253 (regression-gated legacy probe),
  #204 (old delegate WASM unrunnable after an stdlib bump), #393 (gitignored
  `Cargo.lock` silently re-keying contracts).
