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

## State Types

```rust
// Contract state - arbitrary byte array
pub struct State<'a>(Cow<'a, [u8]>)

// State modification - like a diff/patch
pub struct StateDelta<'a>(Cow<'a, [u8]>)

// Compact summary for synchronization
pub struct StateSummary<'a>(Cow<'a, [u8]>)

// Configuration passed at contract creation
pub struct Parameters<'a>(Cow<'a, [u8]>)
```

## Update Types

```rust
pub enum UpdateData<'a> {
    State(State<'a>),                    // Full state replacement
    Delta(StateDelta<'a>),               // Incremental update
    StateAndDelta { state, delta },      // Both for verification
    RelatedState { related_to, state },  // From another contract
    RelatedDelta { related_to, delta },
    RelatedStateAndDelta { ... },
}
```

## Validate Results

```rust
pub enum ValidateResult {
    Valid,
    Invalid,
    RequestRelated(Vec<RelatedContract>),  // Need other contract state
}
```

## Composable State Pattern

River uses `freenet-scaffold` for modular state management. The `#[composable]` macro generates boilerplate for:
- State verification
- Delta computation
- Delta application
- State summarization

### Example: Room State Structure

```rust
use freenet_scaffold::composable;

#[composable]
pub struct ChatRoomStateV1 {
    pub configuration: AuthorizedConfigurationV1,  // Room settings
    pub bans: BansV1,                               // Banned members
    pub members: MembersV1,                         // Member list
    pub member_info: MemberInfoV1,                  // Nicknames, metadata
    pub secrets: RoomSecretsV1,                     // Encrypted secrets
    pub recent_messages: MessagesV1,                // Chat messages
    pub upgrade: OptionalUpgradeV1,                 // Contract upgrade
}
```

### ComposableState Trait

Each field implements this trait:

```rust
pub trait ComposableState {
    type ParentState;
    type Summary;
    type Delta;
    type Parameters;

    fn verify(
        &self,
        parent: &ParentState,
        params: &Parameters
    ) -> Result<(), String>;

    fn summarize(
        &self,
        parent: &ParentState,
        params: &Parameters
    ) -> Summary;

    fn delta(
        &self,
        parent: &ParentState,
        params: &Parameters,
        summary: &Summary
    ) -> Option<Delta>;

    fn apply_delta(
        &mut self,
        parent: &ParentState,
        params: &Parameters,
        delta: &Option<Delta>
    ) -> Result<(), String>;
}
```

## The Delta to an Up-to-Date Peer

When a peer's summary shows it already holds everything your state has, the delta
you owe it carries no information, and its size has to reflect that. Three tiers:

- **MUST NOT** return a delta that contains the state, or whose size approaches
  the state's. This is the real defect.
- **SHOULD** return a literally empty `StateDelta` (`vec![]`, zero bytes). It is
  the unambiguous "converged" answer, and it is what `freenet-scaffold` gives you
  for free.
- **Acceptable:** a small fixed amount of encoding framing, the tens of bytes you
  get from serializing a delta struct whose fields are all empty. Prefer zero,
  but this is not a bug and the network will not penalise it.

What matters is delta size **relative to state size**, not the exact byte count.
Twenty bytes against a 500 KB state is fine. A state-sized delta is not. Those
are five orders of magnitude apart, and no encoding choice moves a contract
across that gap.

Peers reconcile by exchanging summaries and asking each other for deltas. Core's
converged test has two steps: byte-identical summaries count as converged
outright, and when the summary bytes differ, core runs your `get_state_delta`
against that peer's summary and treats a zero-byte result as converged. Your
contract answers the second question.

That is what the three tiers are measuring. A delta that is empty in meaning but
not in bytes still fails the second check, so core reads "this peer is stale" and
sends it; at a few tens of bytes that is cheap, which is why it is tolerable. A
state-sized delta fails the same check while costing the entire state, on every
reconciliation, forever.

### Aim for zero bytes

Zero is worth aiming for because it is the only result that passes core's second
check. Note that "empty" here means zero bytes rather than "a struct whose fields
are all empty": serializing an all-`None` delta struct still costs about a byte
per field with bincode, and tens of bytes with CBOR, because ciborium writes the
field names.

```rust
// Returns bytes even with nothing to send, so this never gives the converged signal.
let delta = MyStateDelta {
    members: None,
    messages: None,
    config: None,
};
let mut delta_bytes = vec![];
into_writer(&delta, &mut delta_bytes)?;   // 28 bytes of CBOR framing, not 0
Ok(StateDelta::from(delta_bytes))
```

```rust
// Better: collapse "no changes" to zero bytes before serializing.
match my_state.delta(&my_state, &parameters, &summary) {
    Some(d) => {
        let mut delta_bytes = vec![];
        into_writer(&d, &mut delta_bytes)?;
        Ok(StateDelta::from(delta_bytes))
    }
    None => Ok(StateDelta::from(vec![])),
}
```

**Whether you get the first shape or the second depends on how you built your
state.** With `freenet-scaffold`, the `#[composable]` derive does the collapse for
you: the generated `delta()` checks whether every field's delta is `None` and
returns `None` for the whole struct if so, which is what makes the `match` above
work. That is why River returns zero bytes. If you hand-roll `get_state_delta`,
or compose state without the derive, your delta type is probably a plain struct
that is never `None`, so you get the framing bytes unless you add the collapse
yourself. That is tolerable rather than broken, but the collapse is two lines, so
add it.

Two related rules:

- **Read the `summary` argument.** A `get_state_delta` that ignores it and
  returns the whole state is the MUST NOT case.
- **`summarize_state(S)` must be far smaller than `S`.** A summary the size of
  the state defeats delta computation entirely, and a summary that is a copy of
  the state is always a bug.

Pin all of this with a test. Assert the size bound, which is the requirement, and
tighten to `== 0` only if your contract collapses to an empty delta:

```rust
#[test]
fn delta_to_an_up_to_date_peer_is_negligible() {
    let state = /* a populated state */;
    let summary = MyContract::summarize_state(params.clone(), state.clone()).unwrap();
    let delta = MyContract::get_state_delta(params, state.clone(), summary.clone()).unwrap();

    // The requirement: no state, nothing close to state-sized. 256 bytes leaves
    // room for encoding framing on a wide struct and is still orders of
    // magnitude below any real state.
    assert!(
        delta.size() < 256,
        "delta to an up-to-date peer was {} bytes against a {} byte state",
        delta.size(),
        state.as_ref().len()
    );
    assert!(
        summary.size() < state.as_ref().len() / 4,
        "summary must be much smaller than state"
    );
}
```

Getting the MUST NOT wrong is expensive for the whole network, not only for your
app. One contract live on Freenet today never reads the summary and returns its
whole state as the delta, 25,403 bytes against a 24,832-byte state, and its
`summarize_state` returns a full copy of the state as well, so every comparison
mismatches and every reconciliation re-ships everything. It accounts for 55.6% of
all broadcast sends on the network, from a static page that has not changed since
February ([freenet/freenet-core#5056](https://github.com/freenet/freenet-core/issues/5056)).
Core is adding a probe for this, so a contract that ships state to peers that
already have it will end up suppressed rather than merely slow.

## Merge Law Requirements

Contract state must form a **join-semilattice** under the merge operation — in
practice, a commutative monoid that is also **idempotent**. This means:

1. **Associativity:** `merge(merge(A, B), C) == merge(A, merge(B, C))`
2. **Commutativity:** `merge(A, B) == merge(B, A)`
3. **Idempotence:** `merge(A, A) == A`
4. **Identity:** There exists an empty/initial state `I` where `merge(A, I) == A`

This ensures that regardless of the order peers receive and apply updates, they all converge to the same final state.

**Idempotence is the one most often missed, and the one the network gives you no
way to avoid.** Delivery is at-least-once: the same state or delta legitimately
arrives more than once, after a retry, a re-subscribe, or anti-entropy healing a
divergence. A merge that changes the state when re-applied therefore never
settles — each redelivery mutates it again, which produces an endless stream of
"new" states to gossip and a contract that cannot converge no matter how healthy
the network is.

This is not hypothetical. Freenet telemetry attributed the largest single source
of network traffic to contracts whose merges do not converge (freenet-core
#5153), and a survey of live contracts found one whose `merge(A, A)` never reached
a fixpoint at all (freenet-core #5320). Note that identity (`merge(A, I) == A`) does
*not* imply idempotence (`merge(A, A) == A`): a merge that appends rather than
unions satisfies the first and fails the second, which is exactly the shape of the
defects found in the wild.

### Testing Commutativity

**Every contract should have unit tests verifying these properties.** Use property-based testing for thorough coverage:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Generate arbitrary valid states for testing
    fn arb_state() -> impl Strategy<Value = MyState> {
        // Define how to generate random valid states
        (any::<u64>(), any::<String>()).prop_map(|(id, data)| {
            MyState { id, data }
        })
    }

    proptest! {
        /// Merging in any order produces the same result
        #[test]
        fn merge_is_commutative(a in arb_state(), b in arb_state()) {
            let ab = a.clone().merge(&b);
            let ba = b.clone().merge(&a);
            prop_assert_eq!(ab, ba);
        }

        /// Grouping doesn't matter: (A merge B) merge C == A merge (B merge C)
        #[test]
        fn merge_is_associative(a in arb_state(), b in arb_state(), c in arb_state()) {
            let ab_c = a.clone().merge(&b).merge(&c);
            let a_bc = a.clone().merge(&b.clone().merge(&c));
            prop_assert_eq!(ab_c, a_bc);
        }

        /// Re-applying the same state changes nothing.
        ///
        /// Delivery is at-least-once, so this WILL happen in production. Merge
        /// twice as well as once: a merge that only settles after one application
        /// passes a naive test and still fails here.
        #[test]
        fn merge_is_idempotent(a in arb_state(), b in arb_state()) {
            let once = a.clone().merge(&b);
            let twice = once.clone().merge(&b);
            prop_assert_eq!(once, twice);
        }

        /// Merging with empty state returns original
        #[test]
        fn merge_identity(a in arb_state()) {
            let empty = MyState::default();
            let merged = a.clone().merge(&empty);
            prop_assert_eq!(merged, a);
        }
    }

    /// Test with specific edge cases
    #[test]
    fn merge_concurrent_updates() {
        let base = MyState::new();

        // Simulate two peers making different updates
        let mut peer_a = base.clone();
        peer_a.add_item(Item { id: 1, value: "from A" });

        let mut peer_b = base.clone();
        peer_b.add_item(Item { id: 2, value: "from B" });

        // Both merge orders should produce identical results
        let a_then_b = peer_a.clone().merge(&peer_b);
        let b_then_a = peer_b.clone().merge(&peer_a);

        assert_eq!(a_then_b, b_then_a);
        assert!(a_then_b.has_item(1));
        assert!(a_then_b.has_item(2));
    }

    /// Test delta round-trip
    #[test]
    fn delta_summary_roundtrip() {
        let state_a = /* ... */;
        let state_b = /* state_a with some updates */;

        let summary_a = state_a.summarize();
        let delta = state_b.delta(&summary_a);

        let mut reconstructed = state_a.clone();
        reconstructed.apply_delta(&delta);

        assert_eq!(reconstructed, state_b);
    }
}
```

### Common Commutativity Bugs

1. **Non-deterministic tie-breakers:** Using random values, or a timestamp read
   from the host clock at merge time. Reading the clock inside a merge is
   deprecated outright as of freenet-core v0.2.132 — see "WASM Environment
   Utilities" below and `state-authorization-patterns.md` → "Time Handling".
2. **Order-dependent collections:** Using `Vec` where order matters instead of `HashMap`/`BTreeMap`
3. **Mutation during iteration:** Modifying state while iterating can produce different results
4. **Missing items in merge:** Only keeping "newer" items without proper conflict resolution

> **The same rule applies to your STATE, and it is a requirement rather than a
> tip.** Freenet peers decide whether they have converged by comparing state
> *bytes*, so two peers holding the same logical state in a different byte order
> never recognise each other as converged and heal forever. A `HashMap` (or
> `HashSet`) anywhere in your state type serializes in iteration order, which
> depends on insertion history, which depends on the order updates happened to
> arrive — so the same merge on two peers yields different bytes. **Use
> `BTreeMap`/`BTreeSet`, or sort before serializing, everywhere in state and
> summaries alike.**
>
> This is why the merge laws above are checked on exact bytes: canonical encoding
> is a platform requirement (freenet-core #5320), not a nicety. A contract that
> merges correctly but encodes non-canonically will be reported as breaking
> commutativity, and the conformance checker will tell you which of the two it is —
> the finding says so explicitly when both results hold the same bytes in a
> different order.
>
> The checker is `fdev verify-merge`, and it is worth running before you believe
> any of the claims in this section about your own contract:
>
> ```bash
> fdev verify-merge --wasm your_contract.wasm --state s1.bin --state s2.bin
> ```
>
> Give it a corpus (`--state` samples, `--transition BASE RESULT` pairs, or a
> `--bundle`) and it exercises the laws against real states. It also emits
> **code diagnostics** that need no corpus at all — `host_clock_import` is the one
> to watch for, reported when the module imports the host clock (see "WASM
> Environment Utilities"). A code diagnostic never changes the exit status: it
> describes the code, it is not a failing law.

> **Determinism matters in your `Summary` type too, for the same reason.** A
> `HashMap` inside a `Summary` (or anything `summarize` returns) serializes in
> nondeterministic order, so two identical states can produce different summary
> bytes. Core compares summaries byte-for-byte to decide whether two peers have
> converged, so nondeterministic bytes make that check misfire (spurious or
> missed heals). Use `BTreeMap` in Summaries. This interacts with a current-core
> propagation limitation where an update to a rarely-changing field can lag
> between peers (freenet/freenet-core#4857); see "Known limitation: a
> rarely-changing field can lag between peers" in `SKILL.md`.

## Commutativity Strategies

### 1. Set-Based Operations

```rust
// Members stored as a set - adding/removing is commutative.
// BTreeMap, not HashMap: state is compared byte-for-byte across peers, and a
// HashMap serializes in insertion order, so two peers that received the same
// members in a different order would encode the same set differently and never
// converge.
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
state — never from `freenet_stdlib::time::now()` inside the merge. It orders and
ranks; it is an untrusted hint, so don't build eviction or expiry on it.

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

When adding new fields to signed structs, include them in the signing bytes immediately. If backwards compatibility is needed (old data has signatures that don't cover the new field), use versioned signatures:

```rust
// V1 signing bytes (original)
fn signing_bytes_v1(id: u64, title: &str, content: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"myapp:item:");
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(title.as_bytes());
    buf.extend_from_slice(content.as_bytes());
    buf
}

// V2 signing bytes (adds new field)
fn signing_bytes_v2(id: u64, title: &str, content: &str, order: u32) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"myapp:item:v2:");  // different prefix!
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(title.as_bytes());
    buf.extend_from_slice(content.as_bytes());
    buf.extend_from_slice(&order.to_le_bytes());
    buf
}

// Verification: try v2 first, fall back to v1
fn verify(&self, id: u64, owner: &VerifyingKey) -> Result<(), String> {
    let v2 = signing_bytes_v2(id, &self.title, &self.content, self.order);
    if owner.verify(&v2, &self.signature).is_ok() {
        return Ok(());
    }
    // Fall back to v1 for old data
    let v1 = signing_bytes_v1(id, &self.title, &self.content);
    owner.verify(&v1, &self.signature)
        .map_err(|e| format!("invalid signature: {e}"))
}
```

**Write a test for every signed field** that verifies tampering with it causes verification to fail.

## Contract Parameters

Parameters are fixed at contract creation and determine the contract's identity:

```rust
#[derive(Serialize, Deserialize)]
pub struct RoomParameters {
    pub owner_verifying_key: VerifyingKey,
    pub room_id: [u8; 32],
}

// Contract key = hash(wasm_code || parameters)
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

## WASM Environment Utilities

```rust
// Logging (links to host)
freenet_stdlib::log::info(&format!("Processing update: {:?}", data));

// Random numbers
let bytes = freenet_stdlib::rand::rand_bytes(32);

// Current time — DELEGATES ONLY.
// Deprecated for contracts as of freenet-core v0.2.132, and staged to trap.
let now: DateTime<Utc> = freenet_stdlib::time::now();
```

**A contract must not call `freenet_stdlib::time::now()`.** `update_state` has to
be a function of its inputs or replicas cannot be guaranteed to converge, so a
merge that reads the wall clock isn't merely breaking the merge laws — they stop
being well-formed statements about it. As of freenet-core v0.2.132 a node warns
when it loads a contract importing the clock and `fdev verify-merge` reports a
`host_clock_import` diagnostic; nothing traps *yet*, but the call is staged to
**trap** (freenet-core#5465). Carry a client-signed timestamp in state and
enforce only monotonicity instead. Delegates are unaffected — private per-node
state, never replicated, no merge laws. Full treatment, including what the swap
costs you, is in `state-authorization-patterns.md` → "Time Handling".

The same determinism requirement applies to `rand_bytes` even though it is not
deprecated: randomness drawn inside `update_state`, `summarize_state` or
`get_state_delta` makes the result depend on which peer evaluated it. Use it for
key generation and nonces on the client side, not inside a merge.

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
   `#[serde(default)]`; fields are never removed or renamed; existing field
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
`BLAKE3(BLAKE3(old_wasm) || stable_params)`, GET the old state, fold it forward,
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
`legacy_delegates.toml` for delegates) listing every historical contract WASM hash
plus the params bytes used to derive its key. The `build.rs` generates a Rust
`const` array from it; the runtime probes each old key at startup.

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
  this: `river-core` code-generates `legacy_room_contracts.toml` and the
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
   delegate, persisted client-side.
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
   sees the marker and re-attempts.
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
| Recovery if a hop fails mid-flight | Pointer is permanent on-chain | `pending_migration_from` marker on delegate |
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
anything the language can await, and correlation is the app's job. (Check your
client before assuming: the TypeScript `FreenetWsApi` is promise-based per
request, so a TS UI *does* have the correlation and can use the wrapper.) There, construct `ProbeDriver` directly and pump it
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
no truncated fold; `SeedLocal`. Must NOT seal: `Indeterminate`, `Recovered` with
unresolved candidates or a truncated fold, any error, and any variant the `match`
did not name. Name the sealing variants explicitly and let the wildcard fall
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
