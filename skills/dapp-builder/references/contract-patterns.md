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

    /// Update state with new data (MUST be commutative)
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

    /// Generate state delta from summary (what the requester is missing)
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

## Commutative Monoid Requirement

Contract state must form a **commutative monoid** under the merge operation. This means:

1. **Associativity:** `merge(merge(A, B), C) == merge(A, merge(B, C))`
2. **Commutativity:** `merge(A, B) == merge(B, A)`
3. **Identity:** There exists an empty/initial state `I` where `merge(A, I) == A`

This ensures that regardless of the order peers receive and apply updates, they all converge to the same final state.

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

1. **Non-deterministic tie-breakers:** Using random values or timestamps captured at merge time
2. **Order-dependent collections:** Using `Vec` where order matters instead of `HashMap`/`BTreeMap`
3. **Mutation during iteration:** Modifying state while iterating can produce different results
4. **Missing items in merge:** Only keeping "newer" items without proper conflict resolution

## Commutativity Strategies

### 1. Set-Based Operations

```rust
// Members stored as a set - adding/removing is commutative
pub struct MembersV1 {
    members: HashMap<VerifyingKey, SignedMember>,
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

## WASM Environment Utilities

```rust
// Logging (links to host)
freenet_stdlib::log::info(&format!("Processing update: {:?}", data));

// Random numbers
let bytes = freenet_stdlib::rand::rand_bytes(32);

// Current time
let now: DateTime<Utc> = freenet_stdlib::time::now();
```

## Contract WASM Upgrade & State Migration

**CRITICAL:** A contract's key is derived from its WASM and parameters:
`contract_key = BLAKE3(BLAKE3(wasm) || params)`. Any change to the contract
WASM (code, dependencies, transitive dependency bumps) produces a new key.
Without a migration plan, **state stored under the old key is stranded**:
existing clients keep subscribing to a contract no one else is publishing to.

Contract upgrade is a design concern you must address *before* the first release,
just like delegate migration (see `delegate-patterns.md`). The rest of this
section is the playbook River uses. Adapt it to your app.

### Preconditions: authorized state + backwards-compatible format

Permissionless contract migration only works if two invariants hold:

1. **Every field in state is cryptographically authorized.** See
   "Cryptographic Verification" above. The new contract must be able to
   re-validate every byte of state carried over from the old contract without
   trusting the node that delivered it. If any field can be forged by an
   untrusted peer, migration becomes an attack vector.
2. **State serialization is backwards-compatible.** New fields use
   `#[serde(default)]`; fields are never removed or renamed; existing field
   formats never change. If a breaking state change is genuinely required,
   create an explicit `StateV2` type with a written migration. Do not try to
   evolve `StateV1` in place.

Without both, the new contract's `validate_state` will reject state from the
old contract, and migration silently fails.

### Embed an upgrade pointer in state from v1

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
`legacy_delegates.toml` for delegates) at the repo root, listing every
historical contract WASM hash plus the params bytes used to derive its key.
The UI's `build.rs` generates a Rust `const` array from it; the runtime probes
each old key at startup. River uses this pattern for delegates; apply the
same idea to contracts.

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

## River Contract Reference

See [River's room-contract](https://github.com/freenet/river/tree/main/contracts/room-contract/src/lib.rs) for a complete implementation, and River's `AGENTS.md` under "Contract Upgrade" for the full upgrade runbook.

State components in [common/src/room_state/](https://github.com/freenet/river/tree/main/common/src/room_state):
- `configuration.rs`
- `member.rs`
- `message.rs`
- `ban.rs`
