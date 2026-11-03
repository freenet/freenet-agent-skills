# Upgrading Contracts and Delegates Safely

This is the hub for upgrading a live Freenet dApp: the playbook below, then the discipline behind it (migration
properties, test harness, rollout). Contract mechanics are under "Contract mechanics" below, and delegate mechanics in
`delegate-migration.md`. Design for it before your first release; read it before your second.

## Upgrading a Freenet dApp: the painless path

**If you are here to upgrade an existing dApp — bump `freenet-stdlib`, ship a new
contract or delegate version, or fix a bug that changes the WASM — start here.**

A routine WASM or stdlib bump is **low-risk and mechanical when you designed for it at v1**. It does not mean recreating
everything and killing invites. The contract key moves on any WASM change, but durable references anchored to a **stable
identifier that does not move with the WASM** (River anchors rooms on the owner's verifying key) let clients re-derive the
new key, so every reference keeps pointing at the right place. River's 0.6 to 0.8 stdlib re-key worked this way: every room
migrated on the next refresh and every invite kept working.

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
   - an **ecosystem-standard pointer contract**: a shared, frozen contract at a derivable address `(author_vk, app_id)`
     whose author-signed state `{version, code_hash, sig}` names the current code hash of another contract or delegate. A
     client resolver ships in `freenet-migrate` (`freenet_migrate::pointer`). It solves **addressing only**: it says nothing
     about whether state or secrets under the old key survived, and assuming they did produces a bug shaped like "this user
     has no data". It is a different mechanism from the in-state `OptionalUpgrade` pointer under "Contract mechanics", which
     only clients already holding a reference to that contract can find. Adoption is thin: publish one for your integrators,
     but do not assume the apps you depend on have one. Resolving a pointer for an app you do not own is
     `building-on-other-apps.md`; status is tracked in freenet-core#2776.

   If v1 exposed a raw contract key as an identifier, fix *that* first — an upgrade
   cannot rescue an identifier that moves with the WASM. See
   `identity-and-addressing.md` and "Architecture invariants" below.

2. **Make the build reproducible, so the key moves only when you mean it to.**
   Commit `Cargo.lock`, pin the toolchain, build `--locked`, and build through one
   canonical script that remaps `CARGO_HOME`, `RUSTUP_HOME` and the repo root and
   refuses if a build-machine path survives. Otherwise a stray `cargo update`, a
   different rustc, an embedded path or a stale `target/` silently re-keys the
   contract and orphans data. See `build-system.md` → "Byte-reproducibility" and
   "Do not let a stray rebuild shift the key" below.

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

4. **Use the `freenet-migrate` crate for the carry-forward instead of hand-rolling it.** The legacy-hash registry, the
   `build.rs` codegen, the backward probe and the preconditions-as-types are identical across apps. `cargo add
   freenet-migrate` (runtime) and `cargo add --build freenet-migrate-build` (codegen and CI hash-guard). The build codegen
   reads River-style `[[entry]]` registries, so an existing hand-rolled registry needs no rewrite. Take the
   `freenet-migrate` release matching your stdlib (table in `build-system.md`); moving between stdlib lines is a re-key
   (`build-system.md`, "Moving up from an older stdlib"). Before you do, run the hardcoded-key check in
   `building-on-other-apps.md`, "Check an existing app first".

   Contract state is the field-proven half (River, Delta and others run it); see "Contract mechanics" below. A delegate
   migration is forward-only and has no node-level mechanism: see `delegate-migration.md`.

5. **Publish the new version, then let clients migrate themselves.** Publish the
   new WASM to the shared production key **from `main` only**, after review and
   green CI (every publish hits the same shared address). Each client, on its
   **next load**, computes old-key vs new-key, GETs the old state, and re-PUTs it
   with subscribe under the new key. The successor's `validate_state` re-verifies every byte, so
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

## A New Version Must Accept Old State

**Once your app has users, a new contract version must be migratable from every
version that has ever held their data.** That is a constraint on which changes
you may make, not a step in the release procedure, and it is what decides later
which bugs are fixable at all. The default to protect:

> Any UI should be able to upgrade a contract, because the state just needs to
> be transferred from old to new — the assumption being that new contracts
> always accept old contract state.

**Preserve this if you possibly can.** When a new version accepts old state,
migration is *pure data transfer*: nobody needs a key, because every record
already carries its own signature (architecture invariant 1, below). What that
buys is not convenience — it is that **a user who never opens your app again
still has their data carried forward, by whoever does.** Migration stops
depending on the continued participation of the person whose data it is.

### A derivation change breaks that default by construction

Change how a record's identity is derived — what its id hashes over — and every
record published under the old rule becomes unverifiable, because the id *is*
the thing that changed. There is no version of "new accepts old" that survives
it. This is not carelessness: content-derived identity is correct (see
`contract-patterns.md` → "Record Identity"), and every existing record was
derived the other way, and both things cannot be had at once for data that
already exists.

So **a derivation change is a breaking change to users' data, not an internal
refactor.** It does not read like one — a few lines in one function, nothing in
the type system moving, every test green — which is exactly why it needs saying.

The case that produced this section: a listing id stopped covering the price (one seller could sign two listings under one
id). The fix made every existing listing unverifiable, the migration fold returned on the first refusal and discarded the
whole predecessor, and then sealed. It passed fmt, clippy, the full suite and a review round.

### Accepting the old format in `verify` is not the answer

It is the obvious first idea, and it fails for two independent reasons.

- **It reopens the hole the change closed.** If the old id did not cover the
  price, accepting the old form means a seller can still mint two listings under
  one id at different prices.
- **It cannot be scoped to old data, because a contract has no history.** A
  contract validating state sees the state and its parameters and nothing else —
  no clock, no write times, no predecessor — so it cannot distinguish a
  genuinely old record from a new one shaped to look old. Any acceptance of the
  old form is acceptance for everybody, forever.

### The escape hatch, and what it costs

Where the change is genuinely unavoidable, the migration can **re-issue** the
old records instead of discarding them: accept the predecessor's record as data,
recompute its id under the current rules, ask the delegate to re-sign it as the
same owner over the same terms, and publish that. Nothing is forged, and the
contract only ever sees new-format records, so the hole stays closed.

**It gives up "any UI can migrate."** Re-signing needs the owner's key, so only
the owner's browser can perform the migration, and only while they still hold
that identity. A user who has stopped opening your app is migrated by nobody —
where under "new accepts old" they would have been carried forward by the next
person to open it. That is a regression in the model: it converts migration from
a property of the data into a property of the owner's continued participation.

It also needs the fold to surface refused records as *needs re-issuing* rather
than *discarded* (the fold is a pure function with no delegate access, which is
what makes it testable — so the re-signing belongs in the UI layer above it),
and it must not seal while anything is still un-reissued.

### The rule, for someone about to change a derivation

If the change makes previously-published records unverifiable:

1. **Try to avoid it.** Can the new version accept old state? That is the
   default, and it is worth real effort, because it is the only option that
   costs nobody anything.
2. If not, it is a **data-breaking change**. Say so in the PR, in those words.
3. Either build the owner-assisted re-issue — knowing it gives up "any UI can
   migrate" — or establish that no published generation holds data anyone would
   miss, **and record who established that, dated.**
4. If the answer is "the data goes", the person who loses it must be told **in
   the app**, in language saying the loss was expected as part of an upgrade
   rather than that something broke.

Settle this before launch: what each id covers, what goes in parameter structs (they are hashed into the address), and the
state shapes. Afterwards there is often no good option left, and the defect is carried indefinitely.

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

Everything below applies to the case where the artifact's **address moves**:
a WASM change, or the parameter change covered just below.

Therefore **the entire risk surface of an upgrade is the migration.** Don't aim
for "risk-free upgrades" (impossible); aim for migrations that are *idempotent,
resumable, non-destructive, regression-gated, and observable*. The five
properties below are the whole game.

### A parameter-struct change is a migration too, and the lineage cannot express it

The formula at the top of this section has two halves, and only one of them is
about WASM. `BLAKE3(code_hash || params)` means **editing a contract's parameter
struct re-keys every instance exactly as surely as editing the WASM does** —
even when the WASM is byte-identical. That half of the formula is easy to forget
because a parameter struct looks like an ordinary type.

The trap is that `freenet-migrate` cannot notice.
`ContractLineageEntry { generation, code_hash, note }` records **no parameter
bytes**, and `contract::predecessor_ids(params, lineage)` maps *one* `params`
— the current build's — over every entry. So after a parameter edit the probe
walks a list of addresses that never existed, takes `NotFound` at each, and
reports a clean "nothing to migrate". **Green tests, green CI, no runtime
symptom, and every instance ever published is orphaned.** A real near-miss:
removing two fields shrank a parameter struct from 109 to 56 CBOR bytes, which
would have silently written off five generations of every seller's store.

The remedy is to freeze a **generation boundary** and derive each predecessor
under the encoding it was actually published with:

```rust
/// Generations at or below this were published under the OLD parameter shape.
/// A fixed historical fact, not a thing to bump on the next re-key.
pub const LAST_LEGACY_STORE_PARAM_GENERATION: u32 = 5;

// A frozen copy of the old struct, written out rather than derived from the
// live type -- deriving it from a type still being edited is how it goes
// quietly wrong a second time.
#[derive(serde::Serialize)]
struct LegacyStoreParameters { /* ...the fields as they were, with the values
                                  the publishing code actually supplied... */ }

let mut by_generation: Vec<(u32, ContractInstanceId)> = lineage
    .iter()
    .map(|e| {
        let params = if e.generation <= LAST_LEGACY_STORE_PARAM_GENERATION {
            &legacy
        } else {
            &current
        };
        (e.generation, contract_id_from_code_hash(&e.code_hash, params))
    })
    .collect();
// Newest-first, by the registry's DECLARED generation and never by slice
// order. `NewestFirst::from_lineage` does this for you; a hand-derived list
// handed to `assume_ordered` must do it itself, or a generation appended out
// of order silently loses the anti-rollback guarantee.
by_generation.sort_by_key(|(generation, _)| core::cmp::Reverse(*generation));
```

Pin the boundary with a test.

**A generation boundary only works while each historical encoding maps onto a
distinct code hash.** If the *same* WASM was ever published under two parameter
shapes, the registry cannot even hold both rows —
`freenet-migrate-build`'s `validate()` rejects a duplicate contract code hash
(`BuildError::DuplicateCodeHash`) — and the branch above picks one encoding per
row regardless, so one historical address is never probed. The general answer is
to keep the historical `(code_hash, parameter_bytes)` **pairs** and derive a
candidate id from each, rather than a boundary over a code-hash-only lineage.
The crate supports it: `NewestFirst::assume_ordered` takes a candidate list the
app derived itself, which `ProbeDriver::new` accepts in place of
`NewestFirst::from_lineage`. A
boundary constant is the simple case of deriving your own candidates, not a
substitute for it.

**The *registry-format* half of this is contract-side specifically.** The
delegate registry can say what the contract registry cannot: `DelegateLineageEntry` stores the full `delegate_key` per row and the
walk uses it verbatim, never re-deriving it, and the registry row carries an optional
`params_hex` that the build-time cross-check honours. So the delegate registry *format* can express a parameter
change, where the contract format cannot express one at all.

**Noticing that you need a row is silent on both sides, though**, and this is
the part to guard yourself. A parameters-only re-key leaves the WASM
byte-identical, so a pre-publish check that compares code hashes reports
"unchanged" and you never append a row — and `Registry::validate()` only
cross-checks the rows that are *present*, so it cannot object to the row you
did not write. Make your publish guard compare the **derived address**
— `blake3(code_hash ‖ params)`, the thing that actually moved — rather than the
code hash alone, or a parameters-only re-key ships with green CI on both sides.

Practical rules:

- **Treat a parameter-struct edit as a re-key event** and put it through the same
  procedure as a WASM change: record the outgoing generation before rebuilding.
- **Prefer moving the field elsewhere.** Parameters are the address; state is
  not. In the near-miss above the two fields moved onto the order record (state)
  rather than staying in parameters, which is the change that caused this. A state field can then be
  *extended* without re-keying anything — subject to architecture invariant 2
  below, which still forbids removing, renaming or repurposing one.
- **Say where the boundary falls in the registry file itself**, next to the rows
  it splits, so the next person appending a row sees it.

## Architecture invariants (decide these before v1 — you cannot bolt them on)

1. **Fully self-authorized state.** If every piece of state carries its own
   signature chaining to an authority, *any* node can GET old-key state and PUT
   it to the new key, and the new contract validates it from the bytes alone —
   migration is permissionless and needs no owner online. The cost: you may never
   accept unauthorized state "temporarily," or you forfeit this. A permissive
   `validate_state` lets a malicious re-PUT win: if any field can be forged,
   migration is an attack vector. See `state-authorization-patterns.md`.
2. **Backwards/forwards-compatible serialization.** The same bytes must validate
   under old and new WASM during the rollout window. Additive-only
   (`#[serde(default)]`, plus `skip_serializing_if` wherever a signature covers
   the encoding — otherwise re-encoding an existing record adds a map entry and
   invalidates every signature ever made over that type; see
   `state-authorization-patterns.md` → Wire-Format Stability), never
   remove/rename/repurpose a field, version-tag when you must break, and pin the
   wire format with round-trip tests against hand-written bytes of the old shape.
   Records a delegate stores follow the same rule: `#[serde(default)]` on every new
   field, so old UIs can read them.
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

State must also merge lawfully: carrying old state into the new key is a merge, and
old and new writes coexist during the rollout. Without these the new contract rejects
old state, or the merge does not converge, and migration silently fails.

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
   set_flag("migration_in_progress");      // in the DELEGATE's secret store --
                                           // see below; namespaced per
                                           // source-version set
   // ... write each entity via CAS ...
   // ONLY after every entity is written:
   clear_flag("migration_in_progress");
   mark_migration_done();
   // On Err / interruption: leave the flag set -> next load re-runs and recovers.

   // On load, keyed per (instance, current_code_hash):
   if flag_set("migration_in_progress") {
       run_migration();                    // partial set -> re-run (idempotent) to fill gaps
   } else if !migration_done(instance, current_code_hash) {
       run_migration();                    // See the trigger rule below.
   }
   ```

   `mark_migration_done()` is reached only from the success path above, on a
   complete `Recovered` ("Silence is not absence"). Never seal it because the
   destination *looks* populated: that is the empty-destination gate in disguise,
   and any earlier write then makes the migration permanently unreachable.
   Contract and delegate sealing differ: a predecessor delegate that answers, even
   with nothing, can seal (`delegate-migration.md`), while a contract `NotFound` is
   unauthenticated and never does.

   For delegate predecessors, `freenet-migrate` offers a durable completeness journal stored in the successor, which
   replaces a hand-rolled in-progress flag on that side; see `delegate-migration.md`. Contract-side sealing stays the app's
   decision.

   **A published Freenet webapp has no browser storage, so the marker belongs in
   the delegate's secret store.** The gateway serves a webapp in an iframe whose
   `sandbox` attribute omits `allow-same-origin`
   (`freenet-core:crates/core/src/server/path_handlers/assets/shell.html`), so the
   app frame has an opaque origin and `window.localStorage` throws. A marker kept
   there works under `dx serve` and is a silent no-op once published. It is silent
   because it fails in the *safe* direction: unreadable reads as "not migrated", so
   the walk repeats forever instead of being skipped. (The *shell* is same-origin
   with the node and has storage, but that origin is shared by every app on the
   node and your app frame cannot reach it.)

   For a **browser** app the delegate's KV store is therefore the only durable
   client-local store left. A non-browser client has its own filesystem and should
   use it. A per-user contract keyed on the user's own verifying key is also
   durable and survives a delegate re-key, at the cost of a network round trip on
   every page load.

   Keeping a *contract* marker in the delegate costs one extra probe when the
   **delegate** re-keys. That is not the defect it looks like **provided your fold
   only ever adds** — check that it does, because a fold that can overwrite makes
   the re-probe a regression rather than waste — and a delegate re-key is the
   moment your secrets moved too, so re-probing then is the honest answer.

   **Before making it durable at all, ask whether the predecessor store is
   genuinely frozen after the re-key.** A durable marker is what makes a wrong
   "nothing there" verdict permanent, so it is only safe when nothing can write
   to a predecessor after you have declared it done. River seals because only its
   current delegate is ever written, apart from an old tab during a rollout, which a
   top-up after the walk covers. ghostkeys
   **bans** durable markers for the opposite reason: a contrast test showed one
   there resurrects a data-loss scenario verbatim. Decide per app, write down
   which way and why, and never port one app's answer to another.

   **If you do make it durable, the next question is whether it must be kept out
   of a delegate export.** The store has to outlive every artifact whose
   migration the marker records, *and* the marker must not survive into a context
   where its claim has stopped being true. Those pull in opposite directions, and
   which wins depends on what the marker names:

   | The marker names… | Keep it out of the export? | Why |
   |---|---|---|
   | a predecessor **delegate** (River) | **Yes** | When the current delegate later becomes a predecessor itself, its store holds these keys; copying them forward asserts the successor already imported that predecessor. It has not — the marker would forge migration state. |
   | a **contract** generation | **No** — put it inside the exported prefix on purpose | "Store contract X's predecessors were folded into it" is a fact about contracts. A delegate re-key does not change it, so carrying it forward is accurate and saves the re-probe above. |

   The two cases call for opposite choices and both are right; copy the
   reasoning, never the choice.

   **Excluding a marker is an explicit predicate, not just a placement.** River
   keeps its markers in the *ordinary* key space and filters them by prefix on
   **both** sides — the fetch path (`candidate_keys`) and the import path
   (`classify_recovered`), via `is_migration_marker_key` — precisely because a
   predecessor read by key enumeration has no prefix boundary to hide behind.
   Placing the marker outside an `ExportScope::Prefix` is a cheap extra guard when
   your export is prefix-scoped; it is not sufficient on its own. The crate's own
   `PRED_DONE_MARKER_KEY_PREFIX` markers are not a third option here: they seal
   *delegate* predecessors, live under a `\0`-prefixed reserved namespace, and
   the driver strips them from exports — but it strips only its own namespace, so
   app-chosen markers stay the app's problem.

   Markers carried inside an export also **consume the export's enumeration
   budget**: `export_scoped` enumerates the whole scope regardless of prefix and
   refuses at `HOST_ENUMERATION_CAP` (4096). Keep the marker key space bounded by
   `(artifact, instance, code_hash)` rather than letting it grow per attempt.

   **The client must not supply a raw storage key.** Take a marker *id* and
   prepend the namespace inside the delegate (`<app>:migrate:` ++ id). The same
   secret store holds private keys, so a request that accepted a raw key would let
   a migration note overwrite a private-key secret, a general hazard for any
   delegate whose secret namespace is shared. Pin it with a test that sends a
   marker id naming an existing private-key secret and asserts the key survives.

   **Key it by `(artifact, instance, current_code_hash)`, mint the ids as hex, and
   require ASCII at the delegate boundary.** Raw bytes in a storage key alias under
   any lossy UTF-8 conversion: River's chat delegate builds its key with
   `String::from_utf8_lossy` (`delegates/chat-delegate/src/utils.rs:9`), which maps
   every invalid byte to U+FFFD, so two distinct 32-byte ids collapse onto one
   marker slot and one gets sealed having never been migrated. Enforcing ASCII in
   the delegate makes that a property of the store rather than a habit of today's
   caller.

   **An unreadable store, a refused write and a malformed id all report "not
   migrated."** The probe then repeats, which is wasteful and safe; reading any of
   them as "already done" skips the migration entirely. A pure function over a
   three-valued lookup, so silence is distinguishable from a definite absence at
   the type level, is the worked shape.

3. **Non-destructive.** Never delete the source until the destination is
   confirmed complete. Keep the old blob/keys as a rollback fallback so an old or
   rolled-back client still finds data. River intentionally leaves the legacy
   `rooms_data` blob in place after exploding it into per-entity keys.
4. **Regression-gated.** Once the destination is populated it is authoritative;
   never let a stale *source* read overwrite newer *destination* data. River #253:
   firing the legacy probe unconditionally let an old delegate's stale snapshot
   clobber rooms the user created after upgrading. "Unconditionally" here means
   *on every load, with nothing recording that it had already finished* — property
   2's durable marker is what stops the repeat, and it is doing half this job. The
   rest of the fix is in the *resolution*, not the trigger: make conflict resolution
   merge rather than replace, and seed the probe from the client's own snapshot so a
   stale source can only ever add. What #253 does **not** license is gating the
   *first* run on the destination: see the trigger rule under "Probe before you write
   to the new key".
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

**Trigger rule.** Probe unconditionally per `(instance, current_code_hash)`, gate only
the repeat on a durable marker, and never gate the first run on the successor being
empty. "Contract mechanics" below covers the probe's outcomes and which of them may seal
a marker.

## Contract mechanics

Contract state moves by a backward probe over a committed, append-only registry of
every past code hash, walked newest first. Reconstruct each predecessor's key from
`BLAKE3(BLAKE3(old_wasm) || params)`, where `params` are the bytes that generation was
published under ("A parameter-struct change is a migration too"), GET the old state,
fold it forward, and re-PUT it with subscribe under the current key. The current hash is never in the
registry. For per-user state with no shared owner the probe is the only option.

### Where the registry lives

- **Put it where the prober is built.** If an outside integrator building from
  crates.io probes, it ships inside the published crate (River's
  `common/legacy_room_contracts.toml`, so `riverctl` has it). If only your UI probes,
  the repo root is fine. If consumers cannot run the sweep at all, do not ship it.
- **A registry edit must not change contract WASM bytes**, or recording a migration
  re-keys the contracts it describes. Keep the registry in a crate outside the
  contract build graph, or inside it behind a `#[cfg(feature)]` the contract builds
  do not enable (River: `#[cfg(feature = "migration")]`). Verify on the artifact:
  edit the registry, rebuild, and compare `b3sum` of the contract and delegate WASM.
  `cargo tree --invert` shows crate edges, not whether bytes moved.

### What the app owns around the probe

- **Set the in-progress marker (property 2) before the first GET**, so a session
  that ends before any GET resolves re-attempts.
- **Key per-user markers and duplicate suppression on the cryptographic identity**,
  not on a mutable alias.

**Cross-user sends with mixed versions.** If users on different contract versions
address each other, the sender must derive the recipient's contract key from the
recipient's advertised WASM hash, not its own. Capture it at contact-import time
from the import GET's `key.code_hash()` (requires `return_contract_code: true`),
store it on the contact record with `#[serde(default)]`, and pass it explicitly
when building the recipient's key. Derivations of your own identity keep using your
embedded hash.

### Driving the probe

`ProbeDriver` is a sans-IO state machine that owns order and adoption: newest
generation first by the registry's generation field, first real state wins, an
undecodable or placeholder response is a miss and advances the walk, late responses
are ignored, and a hop cap bounds the walk. The app pumps I/O and supplies a
`ProbeStateOps` adapter.

`migrate_contract` is a thin async wrapper over it that awaits a `ProbeIo::get` per
candidate: right for a CLI, a bridge, a test harness, or anything with awaitable
request and response correlation. A Rust browser app on stdlib's `WebApi` has none,
because every response goes to one app-registered handler. There, construct
`ProbeDriver` directly: `next_action()`, send the GET and arm a timeout, feed the
result to `on_response`, `on_absent` or `on_unknown` (an expired timer is
`on_unknown`), then `take_outcome()` at `Step::Done`. Hand-pumping also puts the
sequencing in code `cargo test` runs on the host.

A TS UI is not exempt. `FreenetWsApi` returns a promise per request and correlates by
contract key, but it rejects on `NotFound` (`"Contract not found"`) and on a deadline
(`"Request timeout"`) alike, so `Absent` and `Unknown` arrive in the same shape,
separable only by matching the error string. The idiomatic
`try { await get() } catch { /* nothing there */ }` is the data-loss default the next
section forbids. Concurrent requests for the same contract are not correlated
exactly, and `migrate_contract` has no JavaScript binding, so a TS app writes the loop
itself.

### Silence is not absence

Your adapter's `ProbeIo::get` returns a three-way `ProbeAnswer`: `State(bytes)`;
`Absent` for the node's real `ContractResponse::NotFound`; and `Unknown` for a
timeout, send failure, dropped transport, cancelled correlation slot, or any other
non-answer. A timeout is never a miss. Under `NewestFirstWins` an unanswered candidate
halts the walk; `ProbeDriver::continue_past_unknown` with a `RollbackRiskAck` opts out
and forfeits the anti-rollback guarantee for that probe. Do not route not-founds
through the deprecated `on_timeout`: it forwards to `on_unknown`, so the walk stops at
its first empty generation and never asks the older ones.

The main outcomes are `Recovered` (a generation had real state), `SeedLocal` (every
candidate was asked and answered, and none had state), and
`Indeterminate { local, unresolved }` (nothing recovered, and at least one candidate
never answered or was never reached because the hop cap fired: adopt nothing, seal
nothing, retry next load). Both `ProbeAnswer` and `Outcome` are `#[non_exhaustive]`,
so a `match` needs a wildcard arm.

**For a contract predecessor, only a complete `Recovered` may record the migration as
finished.** A `NotFound` is unauthenticated, and a contract that exists can answer it
while unfindable, which is common rather than momentary. An undecodable answer is a miss
too, so a schema break across a whole lineage lands on `SeedLocal` with every generation intact. Read `SeedLocal` as "asked
everyone, found nothing this time": seeding your local snapshot forward on it is fine,
and sealing on it is not. Only `Recovered` with no unresolved candidates and no
truncated fold may seal. An instance with nothing to recover gets a rate limit on
re-walking, never a seal. Name that case explicitly and let the wildcard arm fall
through to "retry next run": a wildcard that defaults to "done" writes a permanent
marker wrongly, today and for every variant added later.

**Never let a single all-`Absent` walk trigger an irreversible act**, such as creating
a fresh identity or telling a user they have nothing. Require the same answer across
separate attempts, plus a connectivity witness: a GET for something you know exists
succeeding in the same window.

`SelectionPolicy::NewestFirstWins` is the default and is safe for delete-by-absence
states. `SelectionPolicy::FoldAll` folds every real generation and is sound only for
tombstoned states with a commutative, idempotent merge, so it takes a loudly-named ack
plus `policy_check` property helpers.

### Optional: an in-state upgrade pointer

An owner can write a field such as River's `OptionalUpgradeV1` announcing the new key
to clients still on old code. It is a courtesy for stragglers. No app drives migration
off it, and it cannot work for per-user state. Add it only if you want un-upgraded
clients told where the new contract lives.

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

**"Real old-format bytes" is the load-bearing phrase, and it is the one that
gets skipped.** Every fixture in your repository builds its records with the
*current* code, so not one of them can hold what a predecessor produced — which
is why a change that made every existing record unverifiable passed a full suite
and a review round with nothing to say about it. The habit generalises past ids:
**wherever old bytes and new code have to meet, the fixture must be bytes, not a
constructor call.** Paste a hex literal captured from the shipped version.

The pin that guards a *future* derivation change has the mirror-image trap.
Pin the **current** derivation's own output — a known-answer test whose expected
value you got by running today's code — so that changing the derivation turns it
red. A fixture that hard-codes the *old* id is refused whatever the derivation
is, so simulating a future change fails zero tests. Check your pin by simulating
the change it exists to catch, not by reproducing the bug you already fixed.

Make this testable by extracting the *decision* (mark-done vs. re-run, given the
in-progress flag) into a **pure function** with a truth-table unit test, rather
than burying it in async load code. River's `decide_per_room_load_action(bool)` is
this pattern; its earlier source-pin-only test had a false positive (it passed
even with the recovery call deleted), so prefer a pure-function behavioral test
and verify by mutation that removing the fix fails the test.

**When a guard provably cannot fail, a source-scrape pin is the right tool —
and the only one.** Mutation testing asks you to name an input that turns the
test red; some guards have none, and they are exactly the guards worth keeping.
The canonical shape is the wildcard arm of a `match` over a `#[non_exhaustive]`
enum: while every variant defined today is named explicitly, the wildcard is
unreachable, so inverting it to the unsafe default leaves every behavioural test
green. It is protecting against a variant a *future* release adds, which no input
you can construct today reaches. One app hit this in its seal decision: inverting
`_ => Seal::Retry` to `Seal::Seal` broke nothing. The remedy is not a better
behavioural test — it is a test that reads the source and asserts the arm exists
and returns the safe value, kept **alongside** the behavioural test rather than
instead of it, with a comment saying why this one guard is pinned that way.
Otherwise the earlier rule (a source pin is a false positive waiting to happen)
gets applied to the one case where it is correct, and the pin is deleted.

**A source scrape only knows what it read, so assert on that too.** One written to
check every production site stopped at the first `#[cfg(test)]` and examined 3% of
the file while reporting success. Assert a floor on how much it examined.

**Three questions worth asking of any migration change in review.** Each names a
failure a green suite let through.

1. **Does the guard at a seam check both sides of it?** `freenet-migrate` offers
   predecessors newest-first, but only the app's writer can see whether the
   successor already holds a key, so an overwriting writer inverts newest-wins and
   neither side reports it. Name what the other side would have to do to defeat the
   check, then confirm something checks that.
2. **Is the test double above or below the bug?** A double above the layer that can
   fail proves only that the layers above agree with each other. The crate's own
   tests drive mocked I/O, which is why adopters gate on a differential test
   against their prior hand-rolled sweep.
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

Publish first to an **isolated key** (a throwaway contract or params) and validate
against a test node, then to the shared production key from `main` only (step 5).
Keep the previous artifact for rollback.

## An open tab cannot upgrade itself: detect the re-key and reload

"Old and new clients coexist" has a special case with a worse failure: a browser tab that was
already open when you published. It runs the build it loaded, with the
contract and delegate WASM compiled in, so after a re-key it keeps using the
OLD keys. Coexistence for that tab lasts until the user happens to refresh,
which for a tab left open can be days.

- **Old contract key:** the tab stays subscribed to a contract everyone else
  has left. Its rooms or documents look like they have gone quiet, and what it
  writes reaches nobody. Neither side sees an error.
- **Old delegate key:** the tab keeps writing to the old delegate after a
  new-build load has migrated from it. If your migration only re-imports
  entries the new build has never seen (River's "top-up"), changes to entries
  it already holds are stranded.

So a dApp that re-keys needs the open tab to notice and reload. River does this in
`ui/src/components/app/freenet_api/generation_watch.rs` (freenet/river#792); copy
its shape rather than reinventing it. The timings and caps below are River's choices,
not node requirements.

**Signal: your pointer records, not your web container.** Publish one pointer
record per re-keying artifact (`freenet-migrate`'s `pointer` module; see
`building-on-other-apps.md`) and have the UI watch them. They are 100 bytes and
move only on a re-key. Watching the web container instead would push the whole
UI archive (MBs) to every open tab on every publish, including UI-only
publishes that strand nobody.

**Transport: GET + subscribe on every (re)connect, plus a slow GET backstop**
(River's: every 15 minutes, ±20% jitter).
A client subscription does not survive a WebSocket reconnect (the client gets a
new id), so re-subscribe each time. Do not rely on polling GETs alone: once the
node is subscribed to the contract or otherwise interested in it (which a tab
watching it makes it), a client GET is answered from the node's local copy, so
a poll never forces a network check. Handle `UpdateData::State`, `Delta` and
`StateAndDelta`; the pointer contract's delta is the whole record. `freenet local`
ignores `subscribe` on a GET, so test the push path against a network-mode node.

**Judgement: seed the resolver with the build's own record.** Bake the build's
pointer `version` and `code_hash` in at build time from the same records file
your signer and CI use. At runtime, check that `BLAKE3(raw WASM bytes the UI
embeds)` equals that `code_hash` (the raw contract or delegate code, not a
packaged container); if not (a local rebuild), turn the watch off for that
pointer. That check fails without telling the user (only a log warning), so add a test that the shipped build
watches every pointer. Seed `PointerResolver` with
`PointerFloor::at(version, hash)`, and treat only a signature-verified record
with a **strictly higher version** as "reload". `PointerOutcome::Resolved`
alone is not enough: it also covers a different record at the build's own
version that wins the equal-version tiebreak, which no build can satisfy. A
pointer BEHIND the build is normal, since the pointer is published after the
UI, and must never trigger a reload.

**Action: reload; do not follow the new key in place.** The old build can
derive the new address, but its code may misread the new generation's state or
send deltas the new contract rejects (format and validation changes are why
you re-keyed), and a delegate cannot be followed at all without the new
build's migration. A fresh load already does everything a re-key needs.

**How to reload a node-served app.** It runs in the shell's sandboxed iframe,
with no `allow-top-navigation`, and the shell ignores app-initiated reload
requests. Do not just `location.replace` the iframe: the shell keeps the old
document's proxied WebSockets open, and the shim numbers sockets from 1 in
every document, so the new page's socket collides with the leaked one and is
fed its stale notifications. Instead post the shell a same-contract
`{__freenet_shell__: true, type: 'navigate', href}`. The shell closes every
proxied socket and replaces the frame, keeping your query (`__sandbox=1`
included). Build `href` from the iframe's own `location.pathname` and query
(same origin, your own contract path), and keep it within 4096 characters: the
shell silently ignores an href that is longer, cross-origin or not a contract
path, so treat one you could not keep within the limit as never posted.
Suppress your own reconnect logic while the reload is in flight, or the
departing page opens a new socket that leaks the same way. Once the reload is
posted, never reconnect at all, even if it never lands: the shell closed the
sockets on accepting it, and a closing socket can look open for up to a minute,
so "still connected" is no proof it was ignored. Give up after about a minute
with a "refresh this tab" banner that also says anything sent before refreshing
may not be delivered. (The shell's `navigate` also pushes a browser history
entry per reload; freenet/freenet-core#5910.) If your app keeps state in the
URL fragment and updates the top-level URL through the shell (`replaceState`
never reaches the iframe), rebuild the fragment from your in-memory copy, not
from the iframe's stale `location.hash`.

**Loop guards: a reload is only as good as what it loads.** The UI archive is
far larger than the pointer, so a node can learn of the re-key before it holds
the new UI, and the reloaded page sees the same newer pointer again. The pointer
arrives in under a second; a multi-MB container reaches a typical peer in seconds
to minutes, with a tail of hours.

- Keep the cap state in a URL parameter, not storage. Storage in the sandboxed
  iframe is unreliable, and a cap that silently resets fails open.
- Allow a few tries per target with backoff sized to that propagation (River: 5
  tries over about an hour), then stop and show a banner with a manual Reload and
  nothing automatic. Add an hourly ceiling across all targets.
- Compare targets per artifact. Two pointers answer milliseconds apart, so a
  page briefly knows only one of them; a target that is no newer in any
  artifact than the one being retried must count as the same target, or
  alternate loads reset the count forever.
- Re-plan on every target move, never shortening a wait.
- One reload per page: once a reload is issued, never issue another. A driver
  that keeps ticking re-navigates every second and each attempt aborts the last.
- Do not reload a page younger than the node's bundle-refresh window plus a
  margin (30 s in the node; River uses 35 s): within it the node serves the
  bundle this page came from.

**Never lose the user's work.** No automatic reload while the user is busy:
unsent text in a composer, an edit in progress, any open dialog (River treats
any visible full-screen modal overlay as busy, which covers every modal at
once), a focused field with text, or an in-flight action such as an invitation
accept. Wait a few seconds after the user stops, so a just-sent message gets
out, and flush pending delegate writes before navigating. A visible tab gets a
short countdown with "Not now". "Not now" should stick across tab switches
(no new countdown while visible); River still reloads a snoozed tab once it has
been hidden for a while, when nobody is looking. A hidden tab reloads after a
jittered delay, so every open tab does not migrate at the same moment.

**Never reload while disconnected, or before a reconnect has caught up.** A
reload against a node that is down replaces the app with the browser's error
page, and until the reconnect has re-registered your delegate and re-synced,
what the reader did offline may not have left. "Connected" should mean "the
reconnect has finished catching up", set at the end of your post-connect work
and cleared wherever the connection is torn down; a status field that also
reads "error" on a live socket is not a substitute. While offline, show a
banner that says so and offers no button that cannot work, and keep it tied to
connection events (a driver that has stopped will not refresh it). A countdown
that ran out offline should restart on reconnect rather than reload at once.
A Reload the reader clicks should skip the busy wait (they decided) but not the
offline one, and if it cannot proceed, restore exactly what was there before
the click.

**Test it.** Write the decisions as pure functions (verdict, caps, timing, and
response-to-plan routing) and unit-test them, then mutate each guard and
confirm a test goes red. Then run it end to end: a throwaway pointer key, a
test build pointed at test records, an isolated network-mode node, and a
browser driver. Check the node's client count is unchanged after a reload. Refuse to
publish a UI built against test records, by checking the built archive (not
the publishing shell's environment) before anything irreversible, such as a
version-counter bump.

**Publish order.** Publish the UI first and the pointer after it, and gate the
pointer publish on the live UI carrying the new WASM (River's
`publish-pointer-records.sh` checks this from the publishing node). Then wait
a couple of minutes, which clears the fast majority of peers. The pointer
publish is now the step that reloads your users' open tabs, so it is not
optional after a re-key, and nothing in CI will notice if you skip it.

## Do not let a stray rebuild shift the key

A WASM rebuild is byte-identical only under the full setup in `build-system.md`
("Byte-reproducibility"), so treat a committed WASM as a frozen artifact. Never `git add -A`, `-u` or `.` in a repo that commits WASM; a stray
rebuilt binary shifts the key and orphans user data. Add files by name. Key
derivation is BLAKE3 (River lost rooms to a SHA256 migration entry).

## References

- `web-container-contract.md`: shipping a new UI is an in-place state update, with no
  re-key and no migration.
- `delegate-migration.md`: delegate secret migration.
- `build-system.md`: byte-reproducibility (`Cargo.lock`, toolchain pin, `--locked`, path
  embedding) and the `freenet-migrate` / stdlib compatibility table.
- `state-authorization-patterns.md`: self-authorizing state, the precondition for
  permissionless migration.
- The `freenet-migrate` README: the crate's API.
- [freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776) is the live
  home base for addressing, contract-state and delegate-secret migration status. Check it
  before trusting any status claim here.
