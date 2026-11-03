# Contract Patterns

Contracts define shared, replicated state that runs on untrusted peers across the Freenet network.

## ContractInterface Trait

Every contract must implement this trait from `freenet-stdlib`:

```rust
use freenet_stdlib::prelude::*;

struct MyContract;

#[contract]  // Generates WASM FFI boilerplate
impl ContractInterface for MyContract {
    /// Verify state validity given parameters and related contracts
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError>;

    /// Update state with new data.
    /// MUST be associative, commutative and idempotent — see "Merge Law
    /// Requirements" below. Merging IS this function: core applies an incoming
    /// full state as `update_state(current, [UpdateData::State(incoming)])`.
    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError>;

    /// Generate concise state summary for delta computation
    /// (MUST be much smaller than the state)
    fn summarize_state(
        parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError>;

    /// Generate state delta from summary (what the requester is missing).
    /// MUST NOT return the state, or anything near its size, when the summary
    /// already matches this state; SHOULD return zero bytes.
    fn get_state_delta(
        parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError>;
}
```

## Composable State

River builds state with `freenet-scaffold` (`use freenet_scaffold_macro::composable;`).
`#[composable]` generates `verify`, `summarize`, `delta` and `apply_delta` from each
field's `ComposableState` impl, and applies fields in declaration order, so a field
that reads another during `apply_delta` must be declared after it. See River's
`common/src/room_state.rs`.

One crafted entry must not refuse a whole delta. See `merge-law-compliance.md` →
"Applying a delta: decide what one bad entry does".

## The Delta to an Up-to-Date Peer

When a peer's summary shows it already holds everything you have, the delta carries
no information.

- **MUST NOT** return the state, or anything near its size. Read the `summary`
  argument.
- **SHOULD** return a literally empty `StateDelta` (`vec![]`). Core treats a zero-byte
  result as converged even when the summary bytes differ; anything else reads as "this
  peer is stale" and gets sent. `freenet-scaffold`'s `#[composable]` collapses an
  all-`None` delta to `None`. A hand-rolled delta struct serializes to framing bytes,
  so collapse it to `vec![]` before encoding.
- **Acceptable:** tens of bytes of framing. What matters is delta size relative to
  state size.

`summarize_state(S)` must be far smaller than `S`. A contract that ignores the summary
and returns its whole state, with a summary that copies the state, re-ships everything
on every reconciliation (freenet-core#5056). `fdev verify-merge` reports
`self_delta_empty` and `whole_state_self_delta` as diagnostics, which never fail the
command.

Pin it with a test: for a populated state, assert that
`get_state_delta(state, summarize_state(state))` is negligible (under 256 bytes, or
`== 0` if you collapse) and that the summary is well under the state's size.

## Merge Law Requirements

`update_state` is the merge: core applies an incoming full state as
`update_state(current, [UpdateData::State(incoming)])`. Aim for a join-semilattice:
associative, commutative and idempotent, so peers converge whatever order updates
arrive in. An empty state `I` with `merge(A, I) == A` is a design convenience the
network does not check, and it does not imply idempotence: a merge that appends
rather than unions passes it and fails `merge(A, A) == A`.

Delivery is at-least-once, so re-delivery is the case you cannot avoid: a merge that
changes the state on re-application produces an endless stream of "new" states to
gossip.

`merge-law-compliance.md` states the laws as the network checks them, including what
a cap or eviction may do, and the tests to write. Every contract should have them.
Common causes of a commutativity failure: random or clock-read tie-breakers, `Vec`
where order matters, and keeping only "newer" items without a conflict rule.

**Canonical encoding is a requirement.** Peers decide they have converged by
comparing bytes, and the laws are checked on exact bytes, so two peers holding the
same logical state in a different byte order heal forever. A `HashMap` or `HashSet`
serializes in iteration order, which differs across peers. Use `BTreeMap`/`BTreeSet`,
or sort before serializing, in state and in summaries. A contract that merges
correctly but encodes non-canonically is reported under commutativity, and the
finding says so when both results hold the same bytes in a different order. To
check, see `merge-law-compliance.md` → "Testing".

## Commutativity Strategies

### 1. Set-Based Operations

```rust
// Members stored as a set: adding is commutative. BTreeMap, not HashMap, so the
// encoding does not depend on iteration order.
pub struct MembersV1 {
    members: BTreeMap<VerifyingKey, SignedMember>,
}

impl MembersV1 {
    fn merge(&mut self, other: &MembersV1) {
        // Union of members, keep if valid signature
        for (key, member) in &other.members {
            if self.verify_member(member).is_ok() {
                self.members.insert(*key, member.clone());
            }
        }
    }
}
```

### 2. Timestamp-Based Ordering

```rust
pub struct MessagesV1 {
    messages: BTreeMap<MessageId, SignedMessage>,
}

// MessageId includes timestamp for deterministic ordering
pub struct MessageId {
    timestamp: DateTime<Utc>,
    author: VerifyingKey,
    sequence: u32,  // Tie-breaker
}
```

The timestamp here comes from the **author's signed payload**, carried in the
state, never from `freenet_stdlib::time::now()` inside the merge. It is an untrusted
hint: it may rank an author's own records, and must not decide whose records are
evicted.

**Note what `MessageId` above does and does not bind.** It identifies a message
by its author and position, not by its content, so the same author can sign two
different bodies under one id — the defect described under "Record Identity"
below. And the `BTreeMap` keyed on it is itself a reader relying on that id: the
map holds one of the two bodies, and unless the merge carries an explicit
deterministic tie-break (the last-writer-wins pattern below has one; a bare
`insert` does not) *which* one is decided by arrival order, so peers diverge.
Add a digest of the signed payload as a **trailing** field of `MessageId` —
trailing because the id is also the map's ordering key, and a leading content
hash would destroy the timestamp ordering this section is about.

### 3. Last-Writer-Wins with Version

```rust
pub struct ConfigurationV1 {
    value: RoomConfig,
    version: u64,
    signature: Signature,
}

fn merge(a: &Self, b: &Self) -> Self {
    if a.version > b.version { a.clone() }
    else if b.version > a.version { b.clone() }
    else {
        // Deterministic tie-breaker (e.g., lexicographic signature)
        if a.signature.as_bytes() > b.signature.as_bytes() { a.clone() }
        else { b.clone() }
    }
}
```

## Cryptographic Verification

**CRITICAL: Every field in contract state must be covered by a signature.** Contracts run on untrusted peers who can modify state. The contract's `validate_state` checks signatures, but only for fields included in the signing bytes. An unsigned field is effectively world-writable.

```rust
use ed25519_dalek::{SigningKey, VerifyingKey, Signature};

pub struct SignedMessage {
    pub content: MessageContent,
    pub author: VerifyingKey,
    pub signature: Signature,
}

impl SignedMessage {
    pub fn verify(&self) -> Result<(), String> {
        let bytes = self.content.to_bytes();
        self.author.verify(&bytes, &self.signature)
            .map_err(|_| "Invalid signature".to_string())
    }
}
```

When adding new fields to signed structs, include them in the signing bytes immediately. If old data has signatures that do not cover the new field, use versioned signatures, and accept the old version only with the new field at its default. A contract cannot tell an old record from a new one shaped to look old, so the default must carry no power.

```rust
fn push_field(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

// V1 signing bytes (original)
fn signing_bytes_v1(id: u64, title: &str, content: &str) -> Vec<u8> {
    let mut buf = b"myapp:item:".to_vec();
    buf.extend_from_slice(&id.to_le_bytes());
    push_field(&mut buf, title.as_bytes());
    push_field(&mut buf, content.as_bytes());
    buf
}

// V2 signing bytes: a different prefix, so a v1 signature can never verify as v2.
fn signing_bytes_v2(id: u64, title: &str, content: &str, order: u32) -> Vec<u8> {
    let mut buf = b"myapp:item:v2:".to_vec();
    buf.extend_from_slice(&id.to_le_bytes());
    push_field(&mut buf, title.as_bytes());
    push_field(&mut buf, content.as_bytes());
    buf.extend_from_slice(&order.to_le_bytes());
    buf
}

fn verify(&self, id: u64, owner: &VerifyingKey) -> Result<(), String> {
    let v2 = signing_bytes_v2(id, &self.title, &self.content, self.order);
    if owner.verify(&v2, &self.signature).is_ok() {
        return Ok(());
    }
    // A v1 signature does not cover `order`, so a v1 record must hold its default.
    if self.order != 0 {
        return Err("v1 signature cannot authorize a non-default order".into());
    }
    let v1 = signing_bytes_v1(id, &self.title, &self.content);
    owner.verify(&v1, &self.signature)
        .map_err(|e| format!("invalid signature: {e}"))
}
```

**Write a test for every signed field** that verifies tampering with it causes verification to fail.

## Record Identity

Signatures answer *who wrote this*. They do not answer *which record is this*,
and that second question is the one that gets designed badly.

**An id that does not cover every term of the record it names lets one author
sign two different records under one id.** A listing id derived from
`(seller, created_at, title)` and not the price is two prices for one listing.
A message identified by a writer-supplied nonce lets a counterparty submit a
different message under an existing nonce and displace it. Both pass every
signature check, because both really were signed by their author.

Under a first-writer-wins merge that is **permanent divergence, and it cannot
heal**: each peer keeps whichever it saw first, both peers' summaries already
name the id, so neither can ever tell the other that anything is missing. This
is worse than a rejected write — the state is diverged and converged-looking at
the same time.

Two rules:

1. **Derive the id from the record's own terms, and compute it in the contract.**
   Never accept an id or a nonce supplied by the writer as identity. If the id
   is a hash, hash *everything a reader will later rely on the id to bind* — the
   price, the payment address, the recipient — not just the fields that felt
   like "the key" when you wrote it.
2. **Exactly one function answers "are these the same thing", and every site
   calls it.** `verify`, `summarize`, `delta`, the dedup check, each merge arm,
   and any migration fold all decide sameness, and they must not each decide it
   themselves. In one app six sites compared a writer-supplied nonce; five were
   correct on the day they were written, and then the identity moved in one file
   and nothing compelled the other five to notice.

A source-scrape test can enforce rule 2 (assert no site derives sameness
itself) — but see `upgrade-and-migration.md` on what such a scrape has to assert
about its own coverage before you can believe it.

**Changing a derivation after publishing is a breaking change to users' data,
not an internal refactor** — every record published under the old rule becomes
unverifiable. Get the coverage right before launch; see
`upgrade-and-migration.md` → "A New Version Must Accept Old State" for what it
costs afterwards.

## Contract Parameters

Parameters are fixed at contract creation and determine the contract's identity:

```rust
#[derive(Serialize, Deserialize)]
pub struct RoomParameters {
    pub owner_verifying_key: VerifyingKey,
    pub room_id: [u8; 32],
}

// Contract key = BLAKE3(BLAKE3(wasm) || parameters)
// Different parameters = different contract instance
```

**A parameter you might want to set later cannot be set later — ever, for that
instance.** Parameters are hashed into the address, so changing one produces a
different contract with empty state; there is no "configure it after creation" for
anything you put here. Shipping a parameter you intend to fill in afterwards is a
permanent defect that is only discovered when someone tries. A marketplace shipped
an empty trusted-bridge list meaning to configure it post-launch; every store
created under it is permanently unable to accept payment. Anything mutable belongs
in *state*, gated by a signature, with the parameter holding only the key that
authorizes the change.

**Keep parameters small.** Every client must carry the exact parameter bytes to
GET/PUT/subscribe an instance, and the parameters often become the basis of a
user-facing identifier. Embedding a full `VerifyingKey` is fine for 32-byte
elliptic-curve keys (River does this), but bad for large keys — post-quantum
public keys run to kilobytes. When the key is large, or when users need a short
shareable "address", store only a short hash of the key in parameters and put
the full key in state, with `validate_state` checking that the key hashes to the
parameter. See `identity-and-addressing.md` for the full pattern.

## WASM Environment

A contract must not read the host clock (`state-authorization-patterns.md` → "Time
Handling"). The same requirement applies to `freenet_stdlib::rand::rand_bytes`, though
it is not deprecated: randomness drawn inside `update_state`, `summarize_state` or
`get_state_delta` makes the result depend on which peer evaluated it. Use it on the
client side for key generation and nonces, not inside a merge.

## Contract WASM Upgrade & State Migration

**CRITICAL:** A contract's key is derived from its WASM and parameters:
`contract_key = BLAKE3(BLAKE3(wasm) || params)`. Any change to the contract
WASM (code, dependencies, transitive dependency bumps) produces a new key.
Without a migration plan, **state stored under the old key is stranded**:
existing clients keep subscribing to a contract no one else is publishing to.

Contract upgrade is a design concern you must address *before* the first release,
just like delegate migration (see `delegate-patterns.md`). The rest of this
section is the key-derivation mechanism and the playbook River uses. **The
`freenet-app-migration` skill owns the doctrine** — when to probe, what may seal a
completion marker, and the failure modes that lose data silently. It is a separate
skill and may not be installed: what follows here is enough to build against, so
read it alongside this section if you have it, and treat a disagreement as a signal
that this file has gone stale rather than as licence to ignore either.

**A user's stable identity must never be a contract key.** Because the contract
key moves on every WASM change, anything you hand users as a permanent handle —
an address, a room reference, a profile link — has to be derived from a key, not
from a contract key. The migration below moves *state* from the old contract key
to the new one; the user-facing identifier stays fixed across that move. See
`identity-and-addressing.md`.

**What this buys you: a routine upgrade is low-risk and mechanical.** When
identity is key-derived, a WASM change is transparent to users. State migrates
itself on next load (the backward probe below), and **every owner-key-derived
reference survives the re-key** — invites, share links, membership, and external
services keyed on the owner identity keep working, because the client re-derives
the new contract key `BLAKE3(BLAKE3(new_wasm) || params)` from the *unchanged
owner key* rather than from a stored contract key. Invites and links do **not**
die on an upgrade (River verified this on the live network with its 0.6→0.8
re-key: rooms kept their state and links minted under 0.6 resolved under 0.8, its
`Invitation` embedding the room owner's verifying key rather than the room
contract key). The one required operational step is registering the *outgoing*
code hash in your legacy-hash registry (below) before the WASM changes, then
republishing. Recreation is only for deliberately changing the *owner* identity
(a compromised key, a genuinely new instance) — never for a routine contract or
stdlib bump. These are consequences of *designing for them* (key-derived
identity + the legacy registry + self-authorizing, backward-compatible state, or
a written carry-forward via `freenet-migrate`), not automatic properties of every
app; migration is per-client on next load, and a fresh device has no local state
to migrate.

### Preconditions (hard requirements — an app lacking these does NOT get safe carry-forward)

Permissionless contract migration only works if all of these hold:

1. **State is mergeable / commutative.** Carrying old state into the new key is a
   merge; if the merge doesn't obey the merge laws (see above), concurrent old and
   new writes during the rollout window won't converge.
2. **Every field in state is self-authorizing.** See "Cryptographic Verification"
   above. The successor's `validate_state` must re-check *every* invariant on the
   bytes alone, without trusting the node that delivered them — this is what makes
   any node able to GET old-key state and re-PUT it under the new key. The corollary
   is a security requirement, not just a correctness one: **a permissive
   `validate_state` lets a malicious re-PUT win.** If any field can be forged by an
   untrusted peer, migration becomes an attack vector, so keep the validator strict.
3. **State serialization is backwards-compatible.** New fields use
   `#[serde(default)]` — plus `skip_serializing_if` wherever a signature covers
   the encoding, which is invariant 2's whole point and bites hardest right here:
   a migration fold deserializes old state and re-serializes it under the new
   WASM, and a field that encodes as `null` when absent invalidates every
   signature in the process (see `state-authorization-patterns.md` →
   Wire-Format Stability). Fields are never removed or renamed; existing field
   formats never change. If a breaking state change is genuinely required,
   create an explicit `StateV2` type with a written migration. Do not try to
   evolve `StateV1` in place.
4. **Identity is key-derived, never a contract key.** The user-facing handle must
   survive the WASM change (see "identity must not be a contract key" above and
   `identity-and-addressing.md`).
5. **You have an app release-signing key** if you use the optional signed-pointer
   path below (the pointer is only trustworthy if the successor's key was signed by
   a key clients already pin).

Without 1–4, the new contract's `validate_state` will reject state from the old
contract, or the merge won't converge, and migration silently fails.

### The shipped baseline: backward-probe from a committed legacy-hash registry

The mechanism River (freenet/river#292) and Delta actually ship — and the one to
build by default — is a **backward probe from a committed registry of past code
hashes**. For each predecessor generation you reconstruct its key from
`BLAKE3(BLAKE3(old_wasm) || params)` — where `params` must be the bytes **that
generation was published under**, which is not automatically today's encoding;
see `upgrade-and-migration.md` → "A parameter-struct change is a migration too".
GET the old state, fold it forward,
and re-PUT it under the current key (the successor's `validate_state` re-verifies
every byte, so any client may do it — the owner need not be online). The registry
is a committed TOML walked newest→oldest; this is written up in full under "the
backward-probe recipe" below. The in-state upgrade pointer described next is an
*optional* layer on top, not the mechanism that moves state.

### Optional richer layer: an in-state upgrade pointer

This is an **optional** addition to the backward-probe baseline, not a
replacement for it. The pointer is real — River defines `OptionalUpgradeV1` and
the owner writes it — but **no app drives migration off it**; it is only a
courtesy for stragglers, and the fuller "author-signed pointer +
`RelatedContracts` auto-follow" model is aspirational (nothing ships it as the
migration driver). The thing that actually moves state is the backward probe
above. Add the pointer only if you also want old, un-upgraded clients to be
*told* where the new contract lives.

Include a field that the room/app owner can set to announce the new key to
clients still running old code:

```rust
#[composable]
pub struct AppStateV1 {
    // ... your real state ...
    pub upgrade: OptionalUpgradeV1,  // Some(new_contract_key) after upgrade
}
```

The pointer is a **courtesy for stragglers**. Updated clients already know the
new key (their bundled WASM hashes to it). Old clients read `upgrade` from the
old contract's state and follow it.

### Upgrade flow

1. **Client ships with new WASM.** On startup, the client computes both keys:
   - `old_key = BLAKE3(BLAKE3(old_wasm_it_knows_about) || params)`
   - `new_key = BLAKE3(BLAKE3(bundled_wasm) || params)`
2. **If `old_key != new_key`, the client migrates:**
   - Subscribes to `new_key`.
   - GETs state from `old_key`, PUTs/merges it to `new_key`. The new contract's
     `validate_state` re-verifies every signature, so this is safe to do from
     any client, not just the original owner.
   - If the client *is* the owner, it also publishes an `OptionalUpgradeV1`
     pointer on the old contract so stragglers can find the new one.
3. **Old clients** that haven't upgraded their WASM yet keep reading the old
   contract, see the `upgrade` pointer, and follow it (read-only) until they're
   updated.

### Register old WASM hashes in a migration file

Maintain a file like `legacy_contracts.toml` (analogous to
`legacy_delegates.toml` for delegates) listing every historical contract WASM
hash. The `build.rs` generates a Rust `const` array from it; the runtime probes
each old key at startup.

**A contract row records the code hash and nothing else** — `freenet-migrate`'s
`ContractLineageEntry` is `{ generation, code_hash, note }`, and
`predecessor_ids(params, lineage)` maps *one* set of parameter bytes over every
row. So the registry cannot express a parameter change, and a parameter edit
orphans every published instance while the probe reports a clean "nothing to
migrate". If your parameters have ever changed shape, you must derive each
generation under its own encoding yourself — see `upgrade-and-migration.md` → "A
parameter-struct change is a migration too". (The delegate rows do not have this
problem: `DelegateLineageEntry` stores the full `delegate_key`, the walk never
re-derives it, and the registry row carries an optional `params_hex` that the
build-time cross-check honours.)

**Placement follows whoever runs the sweep. Ask "who probes?", not "where do
registries go?"** Put the registry in whatever crate the probing code is built from.

- **An outside integrator building from crates.io probes** → it must ship inside the
  published crate. River's `common/legacy_room_contracts.toml` says why in its own
  header: it "lives inside the `common` crate, not at the repo root, so it ships
  inside the published `river-core` crate and riverctl built from crates.io still has
  the full registry." At the repo root it would be invisible to that tool, which
  derives only the current key.
- **Only the app's own UI probes** → the repo root is correct, and publishing it just
  adds a copy that can go stale. River's *delegate* registry sits at its repo root for
  exactly this reason, in the same repo as the contract registry that does not.

The two are not in tension; they answer different questions. The tell is whether a
consumer *could* run the sweep at all. In ghostkeys it structurally cannot: third-party
apps are granted `{ReadPublic, Sign}` and never `Export`
(`delegates/ghostkey-delegate/src/permissions.rs:99`), so shipping them the registry
would hand them a table they are incapable of using. `ghostkey-common 0.3.0` therefore
ships no registry, and that is correct rather than a gap.

**"Who probes?" orients the choice; this invariant constrains it. A one-line
registry edit must not change the contract WASM bytes.** Otherwise recording a
migration re-keys the very contracts the registry describes, and you have built
a registry that *causes* the migration it exists to record. The hazard is real
and easy to walk into, because the registry's natural home — the shared "common"
crate — is usually the one that compiles into the contracts.

Two shapes satisfy the invariant, and which one you want depends on who needs
the table:

- **Registry in a crate outside the contract build graph.** Simplest, and right
  when only your own UI probes. In the Harvest marketplace `harvest-common`
  compiles into all three contracts and the delegate while `harvest-ui` compiles
  into none, so the codegen lives in `harvest-ui/build.rs` even though both are
  shared crates. Decide from the dependency direction, not from which crate is
  named "common".
- **Registry inside the graph, but `#[cfg]`-gated off the contract builds.**
  Right when an outside integrator builds against the crate and needs the table
  (the case above, where placement and the invariant pull apart). River does
  this: `river-core` code-generates `legacy_room_contracts.rs` from the
  checked-in `legacy_room_contracts.toml`, and the
  room-contract depends on `river-core`, but the generated module sits behind
  `#[cfg(feature = "migration")]`, which the contract and delegate WASM builds
  do not enable — so the registry is reachable from crates.io and `riverctl`
  while the contract bytes never see it.

**Verify it, don't infer it.** `cargo tree --invert` tells you crate edges, not
whether bytes moved, and it would wrongly condemn River's arrangement. The test
is the artifact: edit the registry, rebuild, and `b3sum` the contract and
delegate WASM against the pre-edit hashes. That is the property you actually
need, and it is the same pre-publish hash check the next section describes.

### Pre-publish check

Add a preflight task that fails if the contract WASM hash has changed from the
last published release without a corresponding entry in the migration file.
This is the same discipline as delegate migration. See
`delegate-patterns.md` for the equivalent script and CI check.

### Rebuild all consumers when WASM changes

CLI tools (e.g. a `riverctl`-style binary) and test harnesses that embed the
contract WASM at build time must be rebuilt and republished together. A stale
CLI with old WASM produces a different key and can't see the new contract's
state. See River's `cargo make publish-all` for how to orchestrate this.

### The backward-probe recipe (River #292, Delta, freenet/mail)

This is the shipped baseline referenced above — the registry-walk that actually
moves state, with **no dependence on an on-chain pointer**. It is the default for
every app, and it is *mandatory* for per-user state with no shared owner: the mail
app is the canonical case — inbox state is per-identity and the user is the only
one who can sign an update to their inbox, so there is no shared "owner" who could
push an upgrade pointer on everyone's behalf. River recovers rooms across
room-contract generations the same way (`common/legacy_room_contracts.toml` →
`common/build.rs` → `LEGACY_ROOM_CONTRACT_CODE_HASHES`, probed by
`common/src/migration.rs`), and Delta uses an identical `legacy_contracts.toml`
probe.

The recipe:

1. **Embed the current contract's WASM hash** in the UI at build time
   (`INBOX_CODE_HASH = include!("…hash.txt")`).
2. **Record per-identity which contract hash that user's state lives
   under**, on the *delegate* (not on-chain) — e.g. an
   `AliasInfo { inbox_wasm_hash: Option<String>, … }` on the identity
   delegate, persisted client-side. The delegate is the right home and the
   only durable one: a published webapp runs at an opaque origin where
   `localStorage` throws. Two placement rules come with it — whether the
   marker travels with a delegate export, and never letting the client
   choose the raw storage key. Both are in `upgrade-and-migration.md`,
   property 2; read them before adding a marker.
3. **Maintain an append-only `LEGACY_*_CODE_HASHES` slice**, ordered
   oldest → newest, listing every prior `INBOX_CODE_HASH` the project
   has shipped.
4. **On UI startup**, compare the recorded hash against current. If
   they match, no-op. If they differ, walk forward through the legacy
   slice starting from the recorded hash, dispatching a GET per
   candidate. The first `GetResponse` to resolve wins — decode the
   state, re-sign with the identity key, PUT under the current
   contract's key. Update the recorded hash on the delegate.
5. **Suppress duplicate migrations** by keying a `MIGRATED_IDENTITIES`
   set on the cryptographic identity (the ML-DSA verifying-key bytes),
   not on the mutable alias.
6. **Persist a retry marker.** Stamp `pending_migration_from = Some(old_hash)`
   on the delegate BEFORE dispatching GETs; clear it only when the PUT
   under the current key succeeds. If the session ends before any GET
   resolves (offline, browser crash, gateway hiccup), the next session
   sees the marker and re-attempts. This marker names a **contract**
   generation, so it is one that should be carried forward on a delegate
   export — see the placement table in `upgrade-and-migration.md`.
7. **Backwards-compat the delegate state** so old UI versions can read
   the new fields: every new field on `AliasInfo` is
   `#[serde(default)]`.

```rust
// ui/src/inbox.rs (or wherever the contract is bundled)
pub const INBOX_CODE_HASH: &str = include_str!("../../published-contract/inbox-hash.txt");

/// Append-only list, oldest → newest. Add the prior INBOX_CODE_HASH here
/// every time you deliberately rotate the inbox contract.
pub const LEGACY_INBOX_CODE_HASHES: &[&str] = &[
    "9F2c…oldest",
    "Bk7L…middle",
    // current INBOX_CODE_HASH is NEVER in this slice
];

#[cfg(test)]
#[test]
fn current_hash_not_in_legacy() {
    assert!(
        !LEGACY_INBOX_CODE_HASHES.contains(&INBOX_CODE_HASH),
        "current INBOX_CODE_HASH must not appear in LEGACY_INBOX_CODE_HASHES"
    );
}
```

**Cross-user sends with mixed versions.** If users on different
contract versions need to address each other (e.g. mail), the *sender*
must derive the recipient's contract key using the recipient's
advertised WASM hash, not the sender's. Capture it at contact-import
time from the import-fetch `GetResponse`'s `key.code_hash()` (requires
`return_contract_code: true` on the GET request), store it on the
contact record (`StoredContactKeys.inbox_wasm_hash:
Option<String>` with `#[serde(default)]` for backwards-compat),
and pass it explicitly when building the recipient's key in the send
path. Own-identity derivations (e.g. updating your own inbox) keep
using the sender's embedded `INBOX_CODE_HASH` and are correct by
construction.

Both variants below use the backward probe to move state; they differ mainly in
whether an in-state straggler pointer is *also* written and who can trigger the
copy:

| Aspect | Probe + straggler pointer (River rooms) | Probe only (mail, Delta) |
|---|---|---|
| Who triggers the migration | Any updated client; owner also writes pointer | The state's signer, in their own UI |
| Where the legacy list lives | Embedded in WASM (read via build.rs from `legacy_contracts.toml`) | A Rust `const &[&str]` slice in the UI |
| Recovery if a hop fails mid-flight | Pointer is permanent on-chain | `pending_migration_from` marker in the delegate's secret store |
| Works for per-user state with no shared owner | Pointer half doesn't apply; probe half does | Yes |
| Works for shared-room / single-owner state | Yes | Yes (probe needs no owner) |

Pick based on whether you want to *also* tell un-upgraded clients where the new
contract lives; either way the probe is what carries the state.

### Reusable tooling: `freenet-migrate`

The registry, the `build.rs` codegen, and the backward probe are the same across
every app, so a reusable crate — `freenet/freenet-migrate` — packages them (plus
the delegate carry-forward and the preconditions above as enforced types). It is
**`freenet-migrate` 0.6.0 on crates.io** (with `freenet-migrate-build` 0.2.0):
`cargo add freenet-migrate` for the runtime carry-forward and `cargo add --build
freenet-migrate-build` for the `build.rs` codegen + CI hash-guard. This is the
mechanism River's contract-migration path runs in production; both the browser UI
and `riverctl` drive it live (River adopted it in freenet/river#434, #436, and
#437), so the contract carry-forward is shipped and reviewed, not a
hand-roll-until-it-lands placeholder.

**Existing apps adopt it without a rewrite.** `freenet-migrate-build` reads the
same River-style `[[entry]]` TOMLs you already keep (`entry_registry`) and emits
plain byte-array *view* consts matching your hand-rolled const shapes
(`contract_hash_view` gives `&[[u8; 32]]`; `delegate_pair_view` gives
`&[([u8; 32], [u8; 32])]`), so call sites, scripts, and CI stay unchanged.
Views-only mode (`canonical_consts(false)`) needs no `freenet-migrate` runtime
dependency. Registries accept hex or base58, and every build validates the hashes
and re-derives `delegate_key == blake3(code_hash || params)`; a grandfathered row
whose recorded key predates that derivation marks itself `irregular_key = true`.

"Without a rewrite" is a statement about the const shapes, not a procedure. The
actual call-site swap in an app that already hand-rolls a sweep has its own
sequence: write the behavioural spec first, dual-run the old and new paths, gate
on a parity test, and know what rollback cannot undo. That is the
`freenet-migrate-adoption` skill.

**The probe decisions live in a sans-IO driver.** The `ProbeDriver` owns order and
adoption while the app pumps I/O and supplies a `ProbeStateOps` adapter (`decode`,
`is_real`, the merges, and `prepare_forward`, the pointer-strip seam for
freenet/river#427). The decisions: newest generation first by the registry
generation field, first real state wins, an undecodable or placeholder response is
a miss and advances the walk, late responses are single-shot ignored, and a hop cap
bounds the walk.

**Which entry point you use is an environment question, and a browser app needs
the driver.** `migrate_contract` is a thin async wrapper that awaits a
`ProbeIo::get` per candidate — right for a CLI, a bridge, a test harness, or
anything with awaitable request/response correlation. A Rust browser app on
stdlib's `WebApi` has none: it delivers every response to a single
app-registered handler, so a request and its answer are not connected by
anything the language can await, and correlation is the app's job. (A TS UI is not simply
exempt. The TypeScript `FreenetWsApi` returns a promise per request, but it
correlates by **FIFO queue position, not contract id** — `resolveNext` is a
`queue.shift()` (`websocket-interface.ts:899-905`) — so it is only correct with
one GET outstanding. And it **rejects** on `NotFound`
(`new Error("Contract not found")`, `:769`) exactly as it rejects on a deadline
(`new Error("Request timeout")`, `:890`), so `Absent` and `Unknown` arrive in the
same shape, separable only by matching an error string. The idiomatic
`try { await get() } catch { /* nothing there */ }` is the data-loss default the
next section forbids. A TS app must rebuild that distinction itself before it can
decide anything — and `migrate_contract` is a Rust crate function with no
JavaScript binding, so it writes the loop either way.) There, construct
`ProbeDriver` directly and pump it
by hand: `next_action()` → send the GET and arm a timeout → feed the result back
through `on_response` / `on_absent` / `on_unknown` (an expired timer is
`on_unknown`) → `take_outcome()` at `Step::Done`. The crate documents this on
`migrate_contract` itself, and the two make identical decisions by construction —
the wrapper is a loop over the same machine. Hand-pumping earns its keep even
where a wrapper would compile: it puts the sequencing in code `cargo test` runs
on the host, leaving only "send a GET, arm a timer, route a response" behind the
wasm gate.

**Silence is not absence.** This is the 0.6.0 break (freenet-migrate#19), and it is
the whole reason to be on 0.6.0. Your adapter's `ProbeIo::get` returns a three-way
`ProbeAnswer`: `State(bytes)`; `Absent` for the node's real
`ContractResponse::NotFound`; and `Unknown` for a timeout, send failure, dropped
transport, cancelled correlation slot, or any other non-answer. A timeout is never
a miss. `ProbeDriver::on_timeout` is deprecated and forwards to `on_unknown`, which
is safe against sealing but is **not a drop-in**: a call site that also routed
positive not-founds through it will now stop at its first empty generation and
never ask the older ones, because under `NewestFirstWins` an unanswered candidate
halts the walk (opting out takes `ProbeDriver::continue_past_unknown` with a
`RollbackRiskAck`, which forfeits the anti-rollback guarantee for that probe). The outcomes are `Recovered` (a generation
had real state), `SeedLocal` (every candidate was asked *and answered*, and none
had state), and `Indeterminate { local, unresolved }` (nothing recovered and at
least one candidate never answered, or was never reached because the hop cap fired;
adopt nothing, seal nothing, retry next load). Both `ProbeAnswer` and `Outcome`
are `#[non_exhaustive]`, so a `match` needs a wildcard arm.

**No outcome licenses recording the migration as finished.** A Freenet `NotFound`
is the strongest negative the network can give and it is still not proof of
absence: absence is unauthenticated, and a contract that exists answers `NotFound`
while it is momentarily unfindable. With the placement migration disabled
(freenet-core#4440) that is the common case rather than the corner case:
present-but-unfindable dead-ends measured ~99.6% of all `get_not_found` traffic in
production telemetry. An undecodable answer is a miss too, so a schema break across
a whole lineage also lands on `SeedLocal` with every generation intact underneath
it. Read `SeedLocal` as "asked everyone, found nothing *this time*". Seeding your
own local snapshot forward on it is fine. If your app must seal something, make the
write idempotent so a later run picks up a generation that was momentarily
unfindable, require the same answer across separate attempts spread in time,
require a connectivity witness (a GET for something you know exists succeeding in
the same window), and never let a single all-`Absent` walk trigger an irreversible
write.

**If your app seals at all, only two outcomes may.** `Outcome` is `#[non_exhaustive]`
(`freenet-migrate-0.6.0/src/driver.rs:354`, whose doc comment notes that this
"protects exhaustive matches only"), so **a wildcard arm that defaults to "done"
writes a permanent marker wrongly** — for today's non-definitive variants and for
every variant added later. May seal: `Recovered` with no unresolved candidates and
no truncated fold — that is the one *positive* result, where you found the data
and know the search was complete. Must NOT seal: `Indeterminate`, `Recovered`
with unresolved candidates or a truncated fold, any error, and any variant the
`match` did not name. **`SeedLocal` must not seal either**, however conclusive an
all-`Absent` walk looks. The crate says so itself: *"`Outcome::SeedLocal`
deliberately does not claim to be sealable"*
(`freenet-migrate-0.6.0/src/driver.rs:160`), because `Absent` is unauthenticated
— see the paragraph above. Seeding your local snapshot forward on `SeedLocal` is
still fine; that is not the same act as sealing. Name the sealing variants explicitly and let the wildcard fall
through to "retry next run".

**Probe unconditionally per `(instance, current_code_hash)`, before anything writes
to the new key.** Gate only the repeat, on a durable marker; never gate the first run
on the successor being empty, because any write to the new key then suppresses the
migration permanently and silently. The doctrine and its failure cases live in the
`freenet-app-migration` skill — read it before designing the trigger.

`SelectionPolicy::NewestFirstWins` is the default and is safe for delete-by-absence
states; `SelectionPolicy::FoldAll` folds every real generation and is only sound
for tombstoned states with a commutative and idempotent merge, so it takes a
loudly-named ack plus `policy_check` property helpers. River drives its event-driven browser probe (freenet/river#436) and
`riverctl`'s synchronous recovery (freenet/river#437) through the same driver.

The one honest caveat is on the **delegate** side: there is no core mechanism
for delegate secret migration and there will not be one. A node-level
copy-forward was designed and shipped, then found forgeable and disabled as a
security fix (freenet-core#5199), and the wire variant was removed from
stdlib `main` (unreleased — crates.io is still 0.8.5). Three trust-model
designs have been tried and rejected, and app-level migration is now settled
standing policy rather than an interim measure. App-level is not hand-rolled,
though: the crate's delegate half is the shared implementation of it, and
River, Delta and ghostkeys all drive it on `main` at 0.5.0. The transport
underneath is still app-side, with the app carrying the export across
`DelegateRequest` round-trips and re-running the old WASM (see
`delegate-patterns.md` → "Delegate secret migration: no core mechanism, and
why" for the full history and current guidance). Tracked live under
[freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776).

## River Contract Reference

See [River's room-contract](https://github.com/freenet/river/tree/main/contracts/room-contract/src/lib.rs) for a complete implementation, and River's `AGENTS.md` under "Contract Upgrade" for the full upgrade runbook.

State components in [common/src/room_state/](https://github.com/freenet/river/tree/main/common/src/room_state):
- `configuration.rs`
- `member.rs`
- `message.rs`
- `ban.rs`
