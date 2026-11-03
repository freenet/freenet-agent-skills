# Delegate Secret Migration

**CRITICAL:** When delegate WASM changes (code changes, dependency updates, even transitive dependency changes), the delegate key changes: `delegate_key = BLAKE3(BLAKE3(wasm) || params)`. Secrets stored under the old key become inaccessible to the new delegate.

This happened to Delta in April 2026 and to River several times. Design the
registry and the successor-side probe in from v1.

## How migration works: re-run the old delegate

There is no `ExportSecrets` request in the wire protocol and no node-level
copy-forward. The mechanism is a backward probe: the app addresses a message to the
predecessor's key, the node re-runs that old WASM, and whatever handler it shipped
with answers. Your UI owns both ends of the round trip and presents the
`MessageOrigin::WebApp` that survives a delegate re-key, so do not reach for
`OriginPolicy::FromDelegate` by analogy.

1. On startup the UI walks a committed registry of every previous delegate key.
2. For each it sends `DelegateRequest::ApplicationMessages { key: old_key, .. }`
   carrying a read request the old WASM understands.
3. The UI re-stores the data under the current delegate. Re-derive what can be
   derived rather than copying it.

An old delegate can answer only what it already handled. River needs no special
handler because its delegate already served general `GetRequest` and `ListRequest`.
A typed protocol is enough if it exposes every key and the key set is fixed. A
dynamic, unguessable key family needs an enumeration or export handler, which you
cannot add retroactively. Read "A delegate migration is forward-only" before you
plan a migration.

**The re-run depends on the old WASM still running.** After a stdlib or ABI bump a
frozen delegate can fail to deserialize what the runtime sends, and data under that
key is then unrecoverable by automatic migration. River's V4 to V6 delegates failed
this way (freenet/river#204). Migrate promptly, and never assume an arbitrarily old
WASM still runs.

## A delegate migration is forward-only

**Adopting `freenet-migrate` does not carry existing secrets forward. The successor
asks; only a predecessor whose already-deployed WASM can answer will.** The crate's
answer is `handle_export_request`, called from your delegate. It authorizes the
caller, enumerates the requested scope via `SecretStore::list_secrets`, and packages
the result. A predecessor built before you added it rejects the request, so the walk
records `PredecessorMigration::Unresponsive` on every load. That earns no marker and
is retried, but the retry can never succeed: delegate secrets are node-local and
encrypted under the node's KEK, so there is no second copy.

**Every release shipped without an export handler adds one more permanently
unrecoverable generation.** The handler does nothing on the day it lands. Its value
is that the next re-key is survivable, so land it before you have anything to
migrate.

Two things the handler must get right, both of which the crate makes
load-bearing at the call site:

- **Fail closed on an unattested caller.** Use a real `OriginPolicy`; never ship
  `Any`. These are private keys.
- **Export by prefix unless the delegate genuinely serves one web app.** A
  delegate's secret namespace is shared by every app using it and the host does
  not slice it per origin, so a whole-scope export hands the requester
  everything. The crate gates that behind
  `SingleAppDelegateAck::i_certify_this_delegate_serves_a_single_web_app()`.
  `ExportScope::Prefix` narrows what you hand over and stays correct if the
  delegate later serves more than one app. It does not, however, buy you a
  smaller enumeration: `export_scoped` calls `list_secrets(b"")` on every
  export, prefix or not, because cap saturation is a whole-scope property — so a
  prefix export is refused by the truncation check below on exactly the same
  terms as a whole-scope one.

Three limits no handler fixes:

- The host caps enumeration per scope (`HOST_ENUMERATION_CAP`, 4096) and truncates
  silently, so `handle_export_request` refuses with `MigrateError::TruncatedExport`.
- Secrets written before the key-enumeration registry (freenet-core#4355) are not
  listed until rewritten. Touch such keys before relying on a whole-scope export.
- Enumeration is best-effort. An unreadable key registry lists as empty rather than
  failing, and a value can be stored without being registered, with only a warning
  on the node. An export can come back short and report success, so check it against
  something else your app holds.

## `Ok(vec![])` is a positive claim, and it seals permanently

`PredecessorSecretsIo::fetch_secrets` returning `Ok(pairs)` or `Ok(vec![])` means "I
asked, and this is what it has". An empty vector seals the predecessor with a
`Done { had_data: false }` marker that is never revisited. Return it for a request
that merely went unanswered and a slow or unreachable predecessor is recorded as
permanently empty, with a clean report.

**`Err` is the right answer for silence:** a timeout, a transport failure, an
undecodable reply, an answered error. It does not abort. The driver records
`Unresponsive`, no marker is written, and the next run re-walks it. The crate's
words: "the cost of a wrong `Err` is one retry, the cost of a wrong `Ok(vec![])` is
the user's data."

Silence and absence must stay distinguishable at the type level, because only one of
them may seal. Make the third value an explicit variant rather than an `Option` that
collapses two of them, route "no usable answer" to retry, and do the reduction in a
pure function so each arm can be mutated red in a test.

A definitive answer is necessary to seal, not sufficient. If anything can still write
to a predecessor, a durable marker strands what arrives later. River seals because
its legacy delegates are frozen; ghostkeys keeps markers in page memory because
sealing can strand late data. Work out which case is yours.

## Preconditions

The carry-forward above only works if:
- **Identity is key-derived, never a delegate or contract key.** The user-facing
  handle (a room's owner key, an address) must survive the key rotation. See
  `identity-and-addressing.md`.
- **You keep an authoritative, append-only registry** of past delegate keys
  (below), and the old WASM is still registered on the node.

## Pre-Publish Safety Check

Add a migration check to your publish task that blocks when the delegate WASM changed without a migration entry. See Delta's `scripts/check-migration.sh` for a complete implementation.

## Migration Entry Registry

Maintain a `legacy_delegates.toml` with all previous delegate WASM hashes:

```toml
[[entry]]
version = "V1"
description = "Initial release"
date = "2026-03-28"
code_hash = "abc123..."    # BLAKE3 of old WASM bytes
delegate_key = "def456..."  # BLAKE3 of code_hash bytes
```

The UI's `build.rs` generates a Rust constant array from this file, which the
migration code probes at startup. This is River's exact pattern:
`legacy_delegates.toml` → `ui/build.rs` → the `LEGACY_DELEGATES` const that
`fire_legacy_migration_request` walks.

## Reusable tooling: `freenet-migrate`

Rather than hand-roll the registry, the `build.rs` codegen and the backward
probe, use `freenet/freenet-migrate`, which packages all of it: the legacy-key
registry, build-time codegen, the backward probe, the delegate carry-forward, and
the preconditions as enforced types.

Take the `freenet-migrate` release matching your stdlib (table in
`build-system.md`). Moving between stdlib lines re-keys every contract and delegate
you build, so treat it as a migration.

Adopting the build codegen is not a rewrite: `freenet-migrate-build` reads the
River-style `[[entry]]` registry above (`entry_registry`) and emits byte-array
*view* consts matching your hand-rolled `LEGACY_DELEGATES` shape
(`delegate_pair_view` gives `&[([u8; 32], [u8; 32])]` in `(delegate_key, code_hash)`
order), with no runtime dependency in views-only mode. Every build re-derives
`delegate_key == blake3(code_hash || params)` and flags a row that predates that
derivation with `irregular_key = true` (River adopted the build codegen this way in
freenet/river#434).

The delegate half has adopters. `migrate_delegate_secrets` and
`register_delegate_with_migration` (the `delegate_migrate` module) are the
app-facing entry points.

An opt-in **completeness journal** tells the app on every load whether every
predecessor was dealt with. Call `begin_migration_journal` on every load (an `Err`
means write nothing migrated this load) and `migrate_delegate_secrets_journaled` for
the walk. If the app writes migrated data itself, `note_app_import_started` returns
an `AppImport`: `Flagged` means write; `AlreadyImported` means write again only if
your merge cannot resurrect a deleted key; any other variant means do not write;
**any `Err`: skip, retry on a later load**. While `interrupted_import()` is true the
successor may not hold everything the user had. Adopt it only if `fetch_secrets`
fails loudly and your predecessors are frozen (README "Knowing when the migration is
done").

**Adopting them is not retroactive.** See "A delegate migration is forward-only".

For the call-site swap in an app that already hand-rolls a sweep, see the
`freenet-migrate` README.

## Delegate secret migration is app-level

There is no node-level mechanism today. Do not wait for one: migrate at the app
level. Status is tracked in freenet-core#2776.

App-level does not mean bespoke: use `freenet-migrate` rather than hand-rolling
another copy of the same sweep.

- **`freenet-migrate` packages the probe.** `migrate_delegate_secrets` and
  `register_delegate_with_migration` run over two adapters you implement:
  `PredecessorSecretsIo` reads predecessors and `SuccessorSecretsIo` writes the
  successor. An app with a hand-rolled sweep should run the crate's walk alongside
  it until the walk field-validates. ghostkeys is the shape to copy: the crate owns
  the walk, and the adapter owns every app-specific judgement.
- **Route the successor write through your app's own import handler.** Copying raw
  `(key, value)` pairs is wrong for any app whose items have cross-entry invariants,
  and it fails silently: a recovered credential lands in the store while the index
  the UI reads never learns about it. `SecretStoreIo` keeps raw-pair behaviour for
  secrets that genuinely stand alone, behind a deliberately loud ack.

  **Four constraints the crate cannot check for you.** The seam makes correct
  behaviour possible; it does not make it automatic, and each of these has cost
  an app its data.

  1. **Never-clobber is your choice, and `UnionAllGenerations` rests entirely on
     it.** The crate cannot read the successor, so it cannot tell a decline from
     an overwrite. Return `ItemWrite::AlreadyAuthoritative` for a key the
     successor already holds. If your import path overwrites instead (the natural
     shape of an app's own import handler), predecessors are still offered
     newest-first, so each older generation overwrites the newer value in turn and
     you end up with the *oldest* generation's value installed and a completely
     clean report. Either decline held keys or do not use Union.
  2. **An aggregate secret is read-merge-write, and constraint 1 does not cover
     it.** An item whose value is a *collection* (an index, a list, a set, a
     count, a signature over a set) must be merged into what the successor
     already holds, not resolved by key precedence in either direction. The two
     ways of getting it wrong are mirror images: declining the write hides
     entries, which is what never-clobber does to ghostkeys' `gk:index`, and
     overwriting deletes them, as forwarding a predecessor's `known_sites`
     straight into Delta's `StoreKnownSites { sites }` would, since that replaces
     the whole list and so destroys every site the user added on the new version.
     Only you know which of your secrets are aggregates.
  3. **Markers must be durable when `record_marker` returns, not batched.**
     `flush_predecessor` flushes what the *items* were buffered into; the crate
     never flushes a marker on its own path. Route markers through the same batch
     as your items and you break twice. A lost `InProgress` marker drops the
     sticky-data flag, so a retry that finds the predecessor empty seals
     `Done { had_data: false }`, and `NewestSnapshotWins` then falls through to
     older generations and resurrects keys the user had deleted. A batched `Done`
     marker is recorded after the only flush the crate performs, so it is never
     flushed at all and the predecessor is re-walked and re-imported on every run.
     Persist markers synchronously, on their own path if necessary.
  4. **Choose the cross-generation policy deliberately. None is free.**
     `NewestSnapshotWins` preserves delete-by-absence, but it halts at the first
     silent predecessor, and silence is normal: most old delegates are simply not
     registered on a given node. With more than one generation it can recover
     nothing older than that point. Use it only for a one-generation lineage.
     `NewestSnapshotWinsContinuePastUnresponsive(ack)` walks past silence. It gives
     up anti-rollback for older generations: if the silent predecessor held the
     newest snapshot, an older value can become authoritative and shadow the real
     one permanently, with a clean report. `UnionAllGenerations(ack)` recovers
     stranded data but resurrects secrets a newer generation deleted by absence,
     inverts silently against an overwriting writer (constraint 1), and can lose the
     newest value for good (freenet/freenet-migrate#15). River uses Union because
     its merge ranks tombstones by generation. Pass one explicitly and know which
     cost you accepted.

  Two smaller traps in the same adapter. `write_secret` must be **idempotent**:
  the crate never re-offers items from a *completed* predecessor, but a retry
  after a partial run re-offers them, so a writer that appends to a list has to
  insert into a set. And `ItemWrite::AlreadyAuthoritative` is **not an error
  channel**: an `Err(_) => ...` arm mapped onto it counts as `skipped`, which
  reads as success, so the predecessor is sealed and never walked again. A write
  that failed is `Failed { retry }`, and when in doubt it is `Retryable`.

**This flow has no user consent, only app-author self-assertion.** Make that choice
knowingly.

**Cover what must survive deliberately.** Anything that must survive a re-key has to
be inside what your probe walks, not along for the ride inside something else.
River's per-room `self_sk` survives only because it sits in the indexed `RoomData`
blob; moving it to its own non-indexed secret would silently stop migrating it
(freenet/river#612).
