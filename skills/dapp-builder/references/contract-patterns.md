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

    /// Update state with new data. This is the merge: see "Merge Law
    /// Requirements" below.
    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError>;

    /// Generate concise state summary for delta computation
    fn summarize_state(
        parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError>;

    /// Generate state delta from summary (what the requester is missing).
    /// See "The Delta to an Up-to-Date Peer" below.
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

### Keep summaries small

Summaries are a large share of network traffic. A heartbeat carries only a digest of each
summary, but the full summary goes to interested peers on every state change and whenever
digests disagree, and it sets the floor for how cheaply a peer can be brought up to date.

1. **Every summary field must be read by `delta()`.** Grep each field against the `delta()`
   bodies. A field nothing reads is dead weight.
2. **A value only compared for equality must be a fixed-width digest, never the thing it
   fingerprints.** Replacing raw signatures with a 16-byte digest took River's `member_info`
   from 135 to 28 bytes per entry.
3. **Size a digest by who controls the colliding inputs.** If a party can grind both sides, 64
   bits is a 2^32 birthday search, so use 128. If the attacker controls one side, 64 may do.
   Put the threat model in the doc comment. A collision is a record that silently never
   propagates.
4. **Assert the encoding; never derive it.** The same 64 bytes cost 66 CBOR bytes as a byte
   string and 119 as a derived tuple, because ciborium maps `serialize_tuple` to an array where
   every byte >= 24 costs two. Hand-write `Serialize` with `serialize_bytes` for fixed-size
   arrays, and pin it with a golden vector: one fixed input, one expected digest, one expected
   length.
5. **Measure size with realistic keys.** A `FastHash(i)` for small `i` encodes in 1-3 CBOR
   bytes and a real key in 9, so a test built from `0..N` understates per-entry cost by about
   30%.
6. **Keep a summary O(1) or sub-linear in what it describes,** or state the element cap that
   bounds it and check `cap × per-entry` against your budget.
7. **A lossy summary is legal when applying an already-held element is a no-op.** K fixed
   buckets, each an 8-byte digest of its contents, give a constant-size summary (River measured
   145 bytes at K=16 against 3,894 for the flat form at 139 members), and `get_state_delta` may
   then return a superset of the true delta. Verify idempotence first. One changed element
   resends its whole bucket, so measure bytes on your own traffic before committing.
8. **A capped or pruning collection needs a retention horizon in the summary.** Without one,
   `delta()` is a pure set difference: the receiver prunes what it received, neither summary
   changes, and the pair re-sends forever. Publish the oldest key held, only at capacity, so it
   strictly increases each exchange.
9. **A summary must not reveal what a recipient is not entitled to.** It reaches more peers,
   more often, than state does.
10. **A summary is a wire-format commitment.** Its hash, width, byte order and serialization
    are frozen at publish. Changing any of them re-keys the contract and strands every existing
    copy, and a stranded generation keeps costing anti-entropy bandwidth (freenet-core#5158).
    Keep a registry of past generations and batch summary changes.

## Merge Law Requirements

`update_state` is the merge: core applies an incoming full state as
`update_state(current, [UpdateData::State(incoming)])`. Aim for a join-semilattice:
associative, commutative and idempotent, so peers converge whatever order updates
arrive in. An empty state `I` with `merge(A, I) == A` is a design convenience the
network does not check, and it does not imply idempotence: a merge that appends
rather than unions passes it and fails `merge(A, A) == A`.

`merge-law-compliance.md` states the laws as the network checks them, including what
a cap or eviction may do, and the tests to write. Every contract should have them.
Common causes of a commutativity failure: random or clock-read tie-breakers, `Vec`
where order matters, and keeping only "newer" items without a conflict rule.

**Canonical encoding is a requirement.** Peers decide they have converged by
comparing bytes, so two peers holding the same logical state in a different byte
order heal forever. A `HashMap` or `HashSet` serializes in iteration order, which
differs across peers. Use `BTreeMap`/`BTreeSet`, or sort before serializing, in state
and in summaries. A contract that merges correctly but encodes non-canonically is
reported under commutativity, and the finding says so when both results hold the
same bytes in a different order.

## Commutativity Strategies

### 1. Set-Based Operations

```rust
// Members stored as a set: adding is commutative.
pub struct MembersV1 {
    members: BTreeMap<VerifyingKey, SignedMember>,
}

impl MembersV1 {
    fn merge(&mut self, other: &MembersV1, params: &RoomParameters) {
        for (key, member) in &other.members {
            // Verify from the record and parameters, never from held state:
            // what is held depends on what arrived first.
            if member.verify(params).is_err() {
                continue;
            }
            // Two records under one key: a rule over their own bytes picks the
            // same one on every peer. A bare `insert` lets arrival order pick.
            match self.members.get(key) {
                Some(held) if held.signature.to_bytes() >= member.signature.to_bytes() => {}
                _ => { self.members.insert(*key, member.clone()); }
            }
        }
        // Caps and any other removal run here, after the union.
        self.cleanup(params);
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

// V2 signing bytes. The tags must be prefix-free: `myapp:item:` is a prefix of
// `myapp:item:v2:`, so a crafted v1 could equal a v2. V2 also binds a stable
// anchor, here the owner key, which a re-key does not move.
fn signing_bytes_v2(owner: &VerifyingKey, id: u64, title: &str, content: &str, order: u32) -> Vec<u8> {
    let mut buf = b"myapp:item2:".to_vec();
    buf.extend_from_slice(owner.as_bytes());
    buf.extend_from_slice(&id.to_le_bytes());
    push_field(&mut buf, title.as_bytes());
    push_field(&mut buf, content.as_bytes());
    buf.extend_from_slice(&order.to_le_bytes());
    buf
}

fn verify(&self, id: u64, owner: &VerifyingKey) -> Result<(), String> {
    let v2 = signing_bytes_v2(owner, id, &self.title, &self.content, self.order);
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

Both forms stay valid, so the merge ranks v2 above v1 for one id, whichever arrives first.

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

A contract's key is `BLAKE3(BLAKE3(wasm) || params)`, so any change to the WASM,
including a dependency or compiler bump, moves the key. Without a migration plan,
state under the old key is stranded. Design for this before the first release:
see `upgrade-and-migration.md`. A user's stable identity must never be a contract
key (`identity-and-addressing.md`).

## River Contract Reference

See [River's room-contract](https://github.com/freenet/river/tree/main/contracts/room-contract/src/lib.rs) for a complete implementation, and River's `AGENTS.md` under "Contract Upgrade" for the full upgrade runbook.

State components in [common/src/room_state/](https://github.com/freenet/river/tree/main/common/src/room_state):
- `configuration.rs`
- `member.rs`
- `message.rs`
- `ban.rs`
