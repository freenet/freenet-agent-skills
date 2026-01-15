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

All state changes should be signed:

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

## River Contract Reference

See [River's room-contract](https://github.com/freenet/river/tree/main/contracts/room-contract/src/lib.rs) for a complete implementation.

State components in [common/src/room_state/](https://github.com/freenet/river/tree/main/common/src/room_state):
- `configuration.rs`
- `member.rs`
- `message.rs`
- `ban.rs`
