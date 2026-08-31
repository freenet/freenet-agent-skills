# State Authorization & Replay Protection Patterns

Hard-won patterns for designing contract state that satisfies the "every piece of data in contract state must be cryptographically authorized" rule. These are cross-cutting concerns that bite when you build your second or third contract; capturing them here so future dApp authors don't relearn them.

If your contract holds state contributed by multiple parties, or state that one party controls but other parties read, this file is for you.

## Authentication Patterns

Every field in contract state must be authorized somehow. Two patterns cover most cases:

### Per-Item Signatures

Use when many similar items are contributed by different parties.

```rust
pub struct Inbox {
    /// Each message independently signed by its sender.
    pub messages: Vec<InboxMessage>,
}

pub struct InboxMessage {
    pub sender: MemberId,
    pub timestamp: u64,
    pub ciphertext: Vec<u8>,
    pub signature: Signature,  // sender signs canonical bytes of the message
    pub room_context: ContractInstanceId,
}
```

Used for: messages signed by senders, members signed by inviters, votes signed by voters.

### Bundled Signature (Configuration Pattern)

Use when one party controls a section of state. Wrap the whole section in an `Authorized*` envelope; the wrapping signature implicitly authorizes everything inside, including the order of contained lists.

```rust
pub struct Inbox {
    pub messages: Vec<InboxMessage>,
    /// Recipient-controlled section. Bundled signature covers the
    /// whole RecipientState, including order of any contained Vecs.
    pub recipient_state: Option<AuthorizedRecipientState>,
}

pub struct AuthorizedRecipientState {
    pub state: RecipientState,
    /// Recipient's signature over canonical bytes of `state`.
    pub signature: Signature,
}

pub struct RecipientState {
    pub version: u64,             // monotonic, replay protection
    pub purged: Vec<u32>,          // FIFO order matters; sig covers it
    // future fields go here, with #[serde(default)]
}
```

Used for: River's room `Configuration`, the inbox's recipient-controlled state, owner-managed metadata.

Adding a new field to a bundled-signed struct doesn't require new per-field auth, just a `#[serde(default)]` for backwards compatibility.

### The Mistake to Avoid

Storing **bare derived/cached fields** with no corresponding authorization. Looks fine because update paths populate them legitimately, but a peer can PUT arbitrary state through `validate_state` and the bare fields won't be verified against anything.

```rust
// BAD: bare fields a malicious PUT can set arbitrarily.
pub struct Inbox {
    pub messages: Vec<InboxMessage>,    // OK — per-item signatures
    pub purged: VecDeque<PurgedId>,     // BAD — no authorization
    pub last_purge_counter: u64,         // BAD — no authorization
}
```

Either store the originating signed events (e.g., a log of `AuthorizedPurge` actions) and derive the cache view at validation time, OR bundle into a signed envelope (`AuthorizedRecipientState`) that authorizes the layout wholesale.

## Replay Protection

### Monotonic Counter

For replaceable signed envelopes (Configuration, RecipientState). Each new version must have `counter > previous`. Replay of older signed states is rejected.

```rust
pub struct RecipientState {
    /// Strictly increasing per-recipient. Each new state must have
    /// version > the previous one's.
    pub version: u64,
    // ...
}
```

Counter goes in the bytes covered by the signature, so signatures are bound to a specific version. Old signed states cannot be replayed because the contract knows the current version is higher.

### Tombstones

For "forgotten but must not return" state. River bans persist as tombstones — re-invitation attempts of banned members are rejected. The inbox's purged list works the same way: explicitly-purged messages can't be re-submitted.

```rust
pub struct RecipientState {
    pub version: u64,
    /// Truncated fast_hash of purged message signatures.
    /// AppendMessages whose hash matches an entry here are rejected.
    pub purged: Vec<u32>,
}
```

Bound the tombstone list. The recipient (or party authorizing tombstones) is responsible for FIFO eviction when full.

### Cross-Context Binding

Include the contract identity (or recipient/room) in bytes covered by every signature. Without this, a signed payload valid for inbox-A can be replayed against inbox-B if both share enough state structure.

```rust
pub fn build_signed_payload_bytes(
    sender: MemberId,
    recipient_vk: &VerifyingKey,        // <-- binds to this inbox
    room_context: &ContractInstanceId,  // <-- binds to membership claim
    timestamp: u64,
    ciphertext: &[u8],
) -> Vec<u8> {
    // ... canonical layout ...
}
```

Cheap; eliminates an entire class of replay attacks.

## Signed-Payload Hygiene

### Prefer Manual Canonical Byte Layout Over CBOR/Serde

CBOR is **not canonical by default**. Two serializers can produce different bytes for the same logical value (e.g., integer encoding modes, map-key ordering). A malicious peer can craft a signed-but-malformed payload that re-encodes differently, breaking signature verification or enabling replay.

Use a fixed manual byte layout for the bytes that signatures cover:

```rust
pub fn build_signed_payload_bytes(...) -> Vec<u8> {
    let ct_len: u32 = ciphertext.len().try_into().expect("ct < 4 GiB");
    let mut out = Vec::with_capacity(...);
    out.extend_from_slice(&sender.to_le_bytes());        // fixed-length
    out.extend_from_slice(recipient_vk.as_bytes());       // 32 bytes
    out.extend_from_slice(room_context.as_bytes());       // 32 bytes
    out.extend_from_slice(&timestamp.to_le_bytes());      // 8 bytes
    out.extend_from_slice(&ct_len.to_le_bytes());         // 4 bytes
    out.extend_from_slice(ciphertext);                    // variable, length-prefixed
    out
}
```

State itself can still use CBOR (via `ciborium`) — only the bytes that go through signature verification need the manual layout.

### Length-Prefix Variable-Length Fields

Without an explicit length prefix, an attacker can submit a truncated ciphertext and the verifier may compute different bytes than the signer did. Always: `len_le_u32 || bytes`.

### Bind All Relevant Context

The signed bytes should commit to:

- **Sender identity** (cryptographically redundant with using sender's VK to verify, but explicit binding removes ambiguity and matches River's other signed structs).
- **Recipient/inbox/contract identity** (prevents cross-instance replay).
- **Logical scope** (e.g., room_context — prevents membership-claim swap).
- **Timestamp** (replay window for new admissions).
- **Content** (the actual payload).

If a field is in state and matters, it should be in the signed bytes.

### Hard-Code Expected Hex in Wire-Format Round-Trip Tests

A test that round-trips its own output catches nothing — `serialize → deserialize → equals input` always passes regardless of encoding changes. Lock the format with a hex constant:

```rust
#[test]
fn inbox_wire_format_locked() {
    let inbox = canonical_test_inbox();
    let bytes = serialize(&inbox);
    const EXPECTED_HEX: &str = "a16d6573736167657381a467...";
    assert_eq!(hex::encode(&bytes), EXPECTED_HEX);

    // Round-trip too, just to catch deserializer asymmetry:
    let parsed: Inbox = deserialize(&bytes).unwrap();
    assert_eq!(parsed, inbox);
}
```

This catches accidental serde attribute drift, ciborium version bumps that change canonical output, and field reordering.

## Time Handling

### Contracts Must Not Read the Host Clock

`freenet_stdlib::time::now()` — the `freenet_time::__frnt__time__utc_now` import — is **deprecated for contracts** as of freenet-core **v0.2.132**. Do not call it from a contract.

The reason is not stylistic. `update_state` has to be a function of its inputs, because that is what makes replicas converge: two peers given the same updates in any order must arrive at the same state, and the merge laws are the statement of that requirement. A merge that reads the wall clock is not a function of its inputs, so the merge laws are not merely *violated* by such a contract — they are not well-formed statements about it. Two peers whose clocks differ by eleven minutes can produce different states from the same delta, and neither of them is wrong.

What v0.2.132 does, exactly:

- A node logs a warning the first time it loads a contract whose WASM imports the clock, naming the contract key.
- `fdev verify-merge` reports a `host_clock_import` code diagnostic.
- **Nothing traps, nothing refuses to load, and no deployed contract broke.** The call still returns a real time.

What comes next (freenet-core#5465): the call is staged to **trap** in a future release. The contract still loads; any actual *call* to the clock fails that operation. Trapping is per-call, so a contract that imports the symbol without ever reaching it keeps working and needs no rebuild or re-key — which matters, because a re-key moves the contract's address, and for a web container that is link rot rather than a republish.

Both the warning and the diagnostic are **import**-level, so a module that links the symbol without calling it is reported too. That superset is deliberate: a call cannot happen without the import, so nothing will trap that was not warned about first.

**Delegates are unaffected** and may keep reading the clock. A delegate holds private per-node state, is never replicated, and has no merge laws, so a clock read in one raises no convergence question at all. Hourly rate limiting inside a delegate is fine.

### Instead: A Signed Timestamp in State, Checked Only for Monotonicity

Put the timestamp **inside the state, in the client-signed payload**, and have the contract check only that it moves forward:

```rust
// timestamp_ms is part of the signed payload, so every peer evaluating this
// update sees the same value and reaches the same state.
if new_beacon.timestamp_ms <= current.timestamp_ms {
    return Err(/* not newer than what we hold */);
}
```

`freenet-weather` is the worked example: `BeaconState.timestamp_ms` is signed by the announcing client, the contract's only check is `new > current`, and there is no clock call anywhere in it.

**Be clear about what this loses.** A client-supplied timestamp is an *untrusted hint*. It is fine for ordering and ranking, and it cannot do the anti-grief job a host-clock skew check was doing, because the party asserting the time is the party being checked — set it far in the future and the check passes. Swapping in a client timestamp while still treating it as authoritative moves the bug rather than fixing it.

The two shapes that show up in practice:

- **Anti-grief on a per-author log** (the common case): cap the log by *count*, or key it on a monotonic counter. A client-supplied timestamp must not be an eviction key.
- **Capability expiry** (rare, and the genuinely hard one): there is no clean in-contract substitute, because the party asserting the time is the party being checked. The available shapes are a sequence number plus a revocation record, or enforcing expiry outside the contract.

**The sharp edge in the usual replacement.** The obvious substitute for a retention window is to derive it from the state's own newest timestamp — a logical clock. That has a real failure mode: one future-dated entry sets the reference permanently, degrading every peer's view from then on with nothing to heal it, where a wall-clock rule would have recovered on its own once real time caught up. If you take this route, bound how far the reference may advance in one update, or use a count cap instead. The migration off the clock is not free; budget for it.

### Skew Checks Against the Host Clock Are Out, Both Directions

An earlier version of this file blessed a **future-skew** check: reject a message timestamped more than K ahead of the host clock. That is exactly the pattern being removed — the #5465 census found it in every clock-importing contract measured on the network — and it is not rescuable by handing the contract the operation's timestamp instead, because an originator-supplied `now` is attacker-controlled: set it high and the check passes. Determinism and trustworthiness are in direct conflict for this check, and a contract needs the trustworthy one, which means the check does not belong inside the merge at all.

```rust
// DON'T DO THIS — the host clock makes the result a function of which peer
// evaluated the update:
if message.timestamp > host_now() + MAX_FUTURE_SKEW_SECS {
    return Invalid;
}
```

Rejecting is the mild version. Of the deployed contracts measured for #5465, 11 silently **prune** future-dated entries inside `update_state`, so the resulting state is a function of the evaluating peer's clock — the exact defect class conformance exists to detect, produced by the capability rather than caught by it.

A **past-skew** check on stored state was always worse, for a reason independent of clocks that still applies to any time-derived rejection in `validate_state`: that function runs on every state load, including state that's been in storage for months. If the contract rejects state with any message older than `MAX_PAST_SKEW_SECS`, then 30 days after an inbox's oldest message arrives, the entire inbox spontaneously becomes invalid. Permanent state destruction.

Replay protection for old messages should use signature-based dedup (signatures are unique per message) and tombstones — never a time window on `validate_state`.

### Checking a Contract

```bash
fdev verify-merge --wasm your_contract.wasm --state s1.bin --state s2.bin
```

It reports a `host_clock_import` **code diagnostic** when the module imports the clock. That is a diagnostic about the code, not a law the contract broke: it does not fail the command, and it is never grounds for removing a contract from the network. The node's warning and this diagnostic come from the same detector, so the developer-facing answer and the node-facing answer cannot disagree.

The bare form — `fdev verify-merge --wasm your_contract.wasm`, no corpus — still prints the clock diagnostic (on stderr), then exits non-zero asking for at least one `--state` or `--transition`. That failure is about the missing corpus, not about the clock.

### The Native Stub Is UB — Now a Delegate Concern

A contract should not be calling `time::now()` at all, which makes this moot there. For **delegate** code, which may still read the clock: the non-WASM stub at `freenet-stdlib/rust/src/time.rs` leaves a `MaybeUninit<DateTime<Utc>>` unwritten and then `assume_init()`s it — undefined behavior on native targets. A host-side test that compiles your delegate for the native target and calls `now()` is reading uninitialized memory. Gate the call and give native tests an override:

```rust
fn host_now_ts() -> u64 {
    #[cfg(target_family = "wasm")]
    {
        freenet_stdlib::time::now().timestamp() as u64
    }
    #[cfg(not(target_family = "wasm"))]
    {
        test_clock::get_or_wall_clock()
    }
}
```

The contract deprecation is enforced entirely node-side; nothing in stdlib changed, so there is no compiler warning to catch a contract that still calls the clock. `fdev verify-merge` is the check.

## Related-Contracts Mechanism

### `validate_state` Can Read Other Contracts

```rust
fn validate_state(
    parameters: Parameters<'static>,
    state: State<'static>,
    related: RelatedContracts<'static>,
) -> Result<ValidateResult, ContractError> {
    // First pass: if room_context isn't in `related`, request it:
    if let Some(missing_id) = self.find_missing_related(&state, &related) {
        return Ok(ValidateResult::RequestRelated(vec![missing_id]));
    }
    // Second pass: related is populated; check membership:
    self.check_membership(&state, &related)
}
```

Host fetches the requested contracts (locally first, then network) and re-invokes `validate_state` with `related` populated.

### Limits

- **Depth = 1.** A contract returning `RequestRelated` on the second pass is a logic error — host rejects.
- **Max 10 related contracts per request** (`MAX_RELATED_CONTRACTS_PER_REQUEST`). Cap your state's distinct related references at validation time so you can't produce a state needing more than 10.
- **10s fetch timeout per request.** Multiple bogus references multiply the latency cost.

### Requesting Related State From `update_state`

`update_state` takes no `related` parameter, but it is not confined to `validate_state` for cross-contract reads: return `UpdateModification::requires(vec![...])` and the host resolves those contracts — local state store first, network only as fallback — and re-invokes `update_state` with the results supplied as `UpdateData::RelatedState` entries. The host also runs `validate_state` after every successful `update_state` and rolls back on `Invalid`, so validate remains the backstop.

**Prefer the `update_state` route where either would work.** Related state resolved during *validation* is never captured by the conformance system (freenet-core#5376), so a contract whose validity depends on that path can never be judged — and an unjudgeable contract reads exactly like a clean one. The update path is captured today.

### Production Track Record

The related-contracts mechanism shipped in freenet-core PR #3650 (March 2026). Comprehensive unit-test suite. Plan for surprises — discovering edge cases in production is what first-users do. Add an explicit local-node smoke test (`e2e-test/`-style) before declaring your dApp production-ready, and consider feature-flagging the dependent UI flow until you've seen the mechanism work in real network conditions.

## Wire-Format Stability

### Forever-Compat Once Shipped

Once any user has state under your contract, the encoding is locked. You cannot reorder fields, rename fields, change tuple ↔ struct, or change CBOR encoder behavior without breaking that user's state.

### Use `#[serde(default)]` on Every Field

Adding a new field to existing state types should be backwards-compatible — old states should still deserialize, with the new field defaulted.

```rust
#[derive(Serialize, Deserialize)]
pub struct Inbox {
    #[serde(default)]
    pub messages: Vec<InboxMessage>,
    #[serde(default)]
    pub recipient_state: Option<AuthorizedRecipientState>,
}
```

`#[serde(default)]` doesn't apply to fields that are required for security (e.g., the contract should never silently accept a message with a defaulted-to-zero `signature`). For those, omit the default and let deserialization fail loudly.

### Don't Default Required Auth Fields

```rust
// BAD: a malformed encoding produces a "valid-shape" zero message
// that may pass validation if a sender accidentally signed over zeros.
pub struct InboxMessage {
    #[serde(default = "default_signature")]      // BAD
    pub signature: Signature,
    #[serde(default = "default_verifying_key")]  // BAD
    pub sender: VerifyingKey,
}
```

These fields must be required; a state lacking them should fail to decode.

## State Size Budget

The host enforces `MAX_STATE_SIZE = 50 MiB` as a hard correctness backstop — a PUT/UPDATE that would exceed it is rejected outright. Plan caps so worst-case state fits with margin:

- Per-item cap × max-items + envelope overhead ≤ 50 MiB.
- Including auth metadata (signatures are 64 bytes, VKs 32 bytes, etc.).
- Including any tombstone/log structures.

Example for the inbox: `MAX_INBOX_MESSAGES = 1000` × `MAX_CIPHERTEXT_BYTES = 32 KiB` = 32 MiB messages, plus ~140 bytes/message metadata = ~32.1 MiB, plus a few KB of recipient_state. Well under the 50 MiB cap — though, per the design target below, `MAX_INBOX_MESSAGES` is a candidate to tune down or to shard further (e.g. archiving older messages into per-time-window contracts) rather than a bound to treat as settled.

**Design target: stay well under 4 MB per instance, regardless of the 50 MiB cap.** The cap is about correctness, not user experience — a GET transfers the entire state before the UI can render anything, so state size is felt directly as load latency, and it's the wire-transfer floor under the streaming behavior described in `ui-patterns.md` → "Large state handling". If a kind of data can grow without bound (message history, uploaded files, a list that only grows), shard by the natural unit of write concurrency — one contract per room, per user, per time-window, per shard-key — so each instance's state stays small no matter how large the dataset gets in aggregate. Treat a multi-MB instance as a signal to split the data model, not to compress harder or budget more cap headroom.

Large *binary* assets served by the UI (audio, video, images, user uploads) are a special case of the same sharding advice, not a new problem: give the asset its own contract instance instead of embedding it in the webapp bundle's state, and reference it from the UI by key. See `ui-patterns.md` → "Large Binary Assets: Their Own Contract, Not the Webapp Bundle" for the same-origin fetch mechanism that makes this work under the gateway CSP.

## Per-Context Identity Considerations

If your dApp uses **per-context signing keys** (River's pattern: the inviter generates a fresh keypair for each new member, scoped to one room):

- Keys are context-scoped, not user-global.
- Looking up a key requires knowing the context (e.g., the room contract instance).
- Cross-context references in signed payloads must include the context-id.
- A user's "global identity" doesn't exist — they have one identity per context.
- Inbox-style contracts that address "this user" must address them in a specific context (e.g., "this user in room X").

This pattern provides cross-context unlinkability for free, at the cost of needing context to look up keys.

## Common Pitfalls List

| Pitfall | Symptom | Fix |
|---|---|---|
| Bare derived field with no auth | Malicious PUT can fabricate it | Bundle in signed envelope OR derive from authoritative log |
| Order-of-list significance unauthorized | Attacker can permute to control eviction | Bundle list in signed envelope |
| Past-skew check on stored state | State spontaneously becomes invalid over time | Drop check; use dedup + tombstones for replay protection |
| CBOR canonicality assumed in signed payload | Re-encoded payload bypasses signature | Use manual byte layout for bytes covered by signatures |
| Self-referential KAT test | Wire-format drift goes undetected | Hard-code expected hex constant |
| Cross-instance signature replay | Same signed bytes work on different inbox/room | Bind context (recipient_vk, contract_id) in signed bytes |
| Default-deserialized auth field | Zero-value message passes a sloppy check | Remove `#[serde(default)]` from signature/sender fields |
| Truncation/extension on variable-length signed field | Attacker submits N-1 bytes of an N-byte ciphertext | Length-prefix every variable-length field in signed bytes |
| Any `time::now()` call in a *contract* | Replicas can diverge, and the merge laws aren't well-formed statements about the contract; a node warns on load today and the call is staged to trap | Carry a client-signed timestamp in state, check monotonicity only; `fdev verify-merge --wasm` reports the import |
| Future-skew check against the host clock | Two peers disagree on whether the same update is valid; the pruning variant makes state a function of the evaluating peer's clock | Drop the check; cap by count or a monotonic counter |
| Native-target `time::now()` in a *delegate's* host-side tests | UB; possibly miscompiled | Gate behind `cfg(target_family = "wasm")`; use test override |
| Permitted distinct related contracts > 10 | Inbox or similar becomes unvalidatable forever | Cap distinct references in `update_state` (defense in depth in `validate_state` too) |

## Reference: River Inbox Contract

The River inbox contract (`contracts/inbox-contract/`) exercises most of these patterns and is the first production user of the related-contracts mechanism. See `freenet/river#230` for the design discussion that produced this file.
