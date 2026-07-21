# Delegate Patterns

Delegates are WebAssembly agents that run locally on the user's device within freenet-core. They act as a "trust zone" for private operations.

> **Note:** Not all delegate capabilities are fully implemented yet. This document focuses on patterns used in River. Features like user permission requests and background monitoring may have limited support.

## DelegateInterface Trait

Every delegate must implement this trait from `freenet-stdlib`:

```rust
use freenet_stdlib::prelude::*;

struct MyDelegate;

#[delegate]  // Generates WASM FFI boilerplate
impl DelegateInterface for MyDelegate {
    /// Process inbound messages, return outbound messages
    fn process(
        parameters: Parameters<'static>,
        // Identifies the caller (web app or peer delegate). Replaced the old
        // `attested: Option<&[u8]>` in stdlib v0.5. See "Inter-delegate messaging".
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError>;
}
```

## Delegate Capabilities

**Currently used in River:**
- Store private data on behalf of users (secrets, keys, preferences)
- Send/receive messages from UIs
- Perform cryptographic operations (signing, encryption)

**Planned but not yet fully implemented:**
- Create, read, and modify contracts
- Create other delegates
- Request user permission for sensitive operations
- Run background tasks (monitoring, notifications)

## Message Types

### Inbound Messages

```rust
pub enum InboundDelegateMsg {
    /// Message from an application (UI or contract)
    ApplicationMessage(ApplicationMessage),

    /// Response to a secret retrieval request
    GetSecretResponse(GetSecretResponse),

    /// User's response to a permission/input request
    UserResponse(UserResponse),

    /// Request to retrieve a secret
    GetSecretRequest(GetSecretRequest),
}
```

### Outbound Messages

```rust
pub enum OutboundDelegateMsg {
    /// Message to an application
    ApplicationMessage(ApplicationMessage),

    /// Request user input or permission
    RequestUserInput(UserInputRequest),

    /// Retrieve a stored secret
    GetSecretRequest(GetSecretRequest),

    /// Store a new secret
    SetSecretRequest(SetSecretRequest),

    /// Update delegate context (for async operations)
    ContextUpdated(DelegateContext),
}
```

## Secret Storage Pattern

> **API drift note (stdlib v0.5+):** The snippets below illustrate the *pre-v0.5* secrets-by-message API (`SetSecretRequest` / `GetSecretRequest` / `GetSecretResponse` as `InboundDelegateMsg` / `OutboundDelegateMsg` variants), plus the old `attested: Option<&[u8]>` context blob. In v0.5+ secrets are accessed **synchronously** via `DelegateCtx::get_secret` / `set_secret` / `has_secret` / `remove_secret`, and context attestation is the `Option<MessageOrigin>` discussed in [Inter-delegate messaging](#inter-delegate-messaging). The conceptual pattern (origin-namespaced keys, async context with pending ops) still applies — only the call shape changed. Update against `freenet-stdlib/rust/src/delegate_interface.rs` when porting to current stdlib.

Delegates use secret storage for private, persistent data:

```rust
fn process(
    parameters: Parameters<'static>,
    origin: Option<MessageOrigin>,
    message: InboundDelegateMsg,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    match message {
        // UI requests to store data
        InboundDelegateMsg::ApplicationMessage(app_msg) => {
            let request: StoreRequest = deserialize(&app_msg.payload)?;

            Ok(vec![OutboundDelegateMsg::SetSecretRequest(
                SetSecretRequest {
                    key: SecretKey::new(request.key.as_bytes()),
                    value: request.value,
                }
            )])
        }

        // Secret was stored, notify UI
        InboundDelegateMsg::GetSecretResponse(response) => {
            // Handle response, send confirmation to UI
            Ok(vec![OutboundDelegateMsg::ApplicationMessage(...)])
        }

        // Wildcard arm required since stdlib v0.6 marked this enum #[non_exhaustive]
        _ => Ok(vec![])
    }
}
```

## Origin-Based Key Namespacing

To isolate data between different apps, prefix keys with the origin contract ID:

```rust
pub struct ChatDelegateKey {
    origin: ContractInstanceId,
    key: String,
}

impl ChatDelegateKey {
    pub fn to_secret_key(&self) -> SecretKey {
        let namespaced = format!("{}:{}", self.origin, self.key);
        SecretKey::new(namespaced.as_bytes())
    }
}

// Keys are stored as: "abc123:user_data"
// Each app (origin) has isolated storage
```

## Inter-delegate messaging

Starting in stdlib v0.5, `DelegateInterface::process()` receives an `Option<MessageOrigin>` (which replaced the older `attested: Option<&[u8]>` parameter). When one delegate sends an `ApplicationMessage` to another delegate via `OutboundDelegateMsg::SendDelegateMessage`, the runtime attests the caller's identity so the receiver can make authorization decisions.

The `MessageOrigin` enum has two variants today:

- `MessageOrigin::WebApp(ContractInstanceId)` — the message was sent by a web application backed by the given contract.
- `MessageOrigin::Delegate(DelegateKey)` — the message was sent by another delegate. The carried key is the runtime-attested identity of the calling delegate.

```rust
match origin {
    Some(MessageOrigin::WebApp(id)) => { /* called from contract UI */ }
    Some(MessageOrigin::Delegate(id)) => { /* called from another delegate, verify id whitelist */ }
    None => { /* unattested — treat as untrusted */ }
    // Wildcard arm required since stdlib v0.6 marked this enum #[non_exhaustive]
    _ => { /* future variants */ }
}
```

**Security note:** Do not trust `MessageOrigin::Delegate` for sensitive operations unless you whitelist the caller's `DelegateKey`. Per the stdlib docs, an inter-delegate message *replaces* rather than composes with any inherited `WebApp` origin the calling delegate may itself hold — the receiver sees only `Delegate(caller_key)` for the duration of the call and does not gain contract access on behalf of any web app the caller was acting for. Authorize on the calling delegate's identity alone.

## Async Operation Pattern

Since delegates are stateless between calls, use context to track pending operations:

```rust
#[derive(Serialize, Deserialize)]
pub struct DelegateContext {
    pending_operations: Vec<PendingOperation>,
}

#[derive(Serialize, Deserialize)]
pub enum PendingOperation {
    WaitingForSecret { request_id: u64, key: String },
    WaitingForUserInput { request_id: u64 },
}

fn process(..., message: InboundDelegateMsg) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    // Load context from attested data
    let mut context: DelegateContext = attested
        .map(|bytes| deserialize(bytes))
        .transpose()?
        .unwrap_or_default();

    let mut responses = vec![];

    match message {
        InboundDelegateMsg::ApplicationMessage(msg) => {
            // Start async operation
            let request_id = generate_request_id();
            context.pending_operations.push(
                PendingOperation::WaitingForSecret { request_id, key: "data".into() }
            );
            responses.push(OutboundDelegateMsg::GetSecretRequest(...));
        }

        InboundDelegateMsg::GetSecretResponse(response) => {
            // Complete pending operation
            if let Some(pos) = context.pending_operations.iter()
                .position(|op| matches!(op, PendingOperation::WaitingForSecret { .. }))
            {
                context.pending_operations.remove(pos);
                // Process and send result to UI
            }
        }
        // Wildcard arm required since stdlib v0.6 marked this enum #[non_exhaustive]
        _ => {}
    }

    // Save updated context
    responses.push(OutboundDelegateMsg::ContextUpdated(
        DelegateContext::new(serialize(&context)?)
    ));

    Ok(responses)
}
```

## User Permission Pattern (Limited Support)

Request user confirmation for sensitive operations. Note: This feature may have limited support in the current Freenet implementation.

```rust
fn process(...) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    match message {
        InboundDelegateMsg::ApplicationMessage(msg) => {
            let request: SignRequest = deserialize(&msg.payload)?;

            // Ask user for permission
            Ok(vec![OutboundDelegateMsg::RequestUserInput(
                UserInputRequest {
                    request_id: generate_id(),
                    message: format!(
                        "Allow {} to sign message: {}?",
                        request.app_name,
                        request.message_preview
                    ),
                    responses: vec!["Allow", "Deny"],
                }
            )])
        }

        InboundDelegateMsg::UserResponse(response) => {
            if response.response == "Allow" {
                // Perform the signing operation
                let signature = sign_message(&response.data);
                Ok(vec![OutboundDelegateMsg::ApplicationMessage(...)])
            } else {
                Ok(vec![OutboundDelegateMsg::ApplicationMessage(
                    ApplicationMessage::error("User denied permission")
                )])
            }
        }
        // Wildcard arm required since stdlib v0.6 marked this enum #[non_exhaustive]
        _ => Ok(vec![])
    }
}
```

## Cryptographic Operations

Delegates are the right place for private key operations:

```rust
use ed25519_dalek::{SigningKey, Signer};

fn sign_message(key: &SigningKey, message: &[u8]) -> Signature {
    key.sign(message)
}

fn encrypt_for_recipient(
    recipient_public_key: &x25519_dalek::PublicKey,
    plaintext: &[u8],
) -> Vec<u8> {
    // ECIES: ephemeral key exchange + symmetric encryption
    let ephemeral_secret = x25519_dalek::EphemeralSecret::random();
    let ephemeral_public = x25519_dalek::PublicKey::from(&ephemeral_secret);
    let shared_secret = ephemeral_secret.diffie_hellman(recipient_public_key);

    // Derive AES key from shared secret
    let aes_key = derive_key(shared_secret.as_bytes());

    // Encrypt with AES-256-GCM
    let ciphertext = aes_gcm_encrypt(&aes_key, plaintext);

    // Return ephemeral public key + ciphertext
    [ephemeral_public.as_bytes(), &ciphertext].concat()
}
```

## Message Flow Example

```
┌────────┐     ┌──────────┐     ┌─────────────┐
│   UI   │────▶│ Delegate │────▶│ Secret Store│
└────────┘     └──────────┘     └─────────────┘
     │              │                   │
     │ StoreRequest │                   │
     │─────────────▶│                   │
     │              │ SetSecretRequest  │
     │              │──────────────────▶│
     │              │                   │
     │              │ GetSecretResponse │
     │              │◀──────────────────│
     │ StoreConfirm │                   │
     │◀─────────────│                   │
```

## DelegateKey Anatomy (CRITICAL)

A `DelegateKey` has **two separate fields**, not one. Confusing them causes silent failures where the node can't find the delegat
```
DelegateKey {
    key:       BLAKE3(code_hash || params)   // the lookup key used by the node
    code_hash: BLAKE3(raw_wasm_bytes)        // hash of the raw WASM file
}
```

### How to Compute Each Field

- **`code_hash`**: `BLAKE3` of the raw `.wasm` file bytes. Compute with `b3sum`:
  ```bash
  b3sum --no-names target/wasm32-unknown-unknown/release/my_delegate.wasm
  ```

- **`key`**: `BLAKE3(code_hash_bytes || params_bytes)`. When params are empty, this is `BLAKE3(code_hash_bytes)` — NOT the same as `code_hash` (which is `BLAKE3(wasm_bytes)`).

### The Double-Hashing Bug

**Bug pattern:** Using `CodeHash::from_code(bytes)` on bytes that are already a hash. `from_code()` runs BLAKE3 on its input. If the input is already a BLAKE3 hash, you get `BLAKE3(BLAKE3(wasm))` instead of `BLAKE3(wasm)`.

This happened in `freenet-stdlib/rust/src/delegate_interface.rs` during FlatBuffers deserialization — the `code_hash` field was already hashed bytes, but the deserialization code re-hashed them.

**Fix:** Use `CodeHash::new(bytes)` (wraps raw bytes) instead of `CodeHash::from_code(bytes)` (hashes then wraps) when working with bytes that are already a hash.

**When building delegate messages from TypeScript**, you must pass BOTH fields correctly:

```typescript
// DelegateKeyT takes (key_bytes, code_hash_bytes) — they are DIFFERENT
const delegateKey = new DelegateKeyT(delegateKeyBytes, delegateCodeHashBytes);
```

If you pass `keyBytes` for both fields (or `codeHashBytes` for both), the node won't find the delegate.

### Pre-Publishing Checklist

1. Compute `code_hash` with `b3sum` on the raw WASM
2. Capture the full `key` from `fdev publish` output (strip ANSI: `sed 's/\x1b\[[0-9;]*m//g'`)
3. Pre-decode both to byte arrays for the UI (base58 → JSON for key, hex → JSON for code_hash)
4. Verify both are injected separately in your build config

## Delegate WASM Upgrade & Secret Migration

**CRITICAL:** When delegate WASM changes (code changes, dependency updates, even transitive dependency changes), the delegate key changes: `delegate_key = BLAKE3(BLAKE3(wasm) || params)`. Secrets stored under the old key become inaccessible to the new delegate.

### The Problem

Delegates store secrets (signing keys, user data) keyed by delegate key. A new WASM = new key = old secrets invisible. Users lose all their private data.

### How migration actually works: re-run the old delegate

There is **no `ExportSecrets` request handler** — earlier versions of this doc
described one, but River ships nothing of the kind. The real mechanism (River's,
and Delta's) is a **backward probe that re-runs the old delegate's own WASM**;
the old delegate needs no special export handler.

1. On startup the successor (new) delegate's UI walks a committed registry of
   every previous delegate key (see "Migration Entry Registry" below).
2. For each predecessor it sends an ordinary read message **addressed to the old
   delegate key** — in River, `DelegateRequest::ApplicationMessages { key:
   legacy_delegate_key, .. }` carrying the chat-delegate's own app-level
   `GetRequest` (fixed keys) and `ListRequest` (to enumerate dynamic per-entity
   keys). Because the key names the old `code_hash`, the node loads and
   **re-runs the old WASM**, which reads its own secret namespace and returns the
   data.
3. The UI folds that data forward and re-stores it under the **current**
   delegate. In River the per-room signing keys are carried forward via
   `migrate_signing_key` (which writes `StoreSigningKey` into the new delegate).

What is carried are the **per-room signing keys**. **Encryption secrets are
re-derived**, not copied out of the old delegate — River rebuilds them from
carried state via `derive_room_secret`. So the migration is: enumerate old keys →
re-run old WASM to read its secrets → re-store the signing keys forward → re-derive
everything else.

> **This step is fragile: it depends on the old WASM still running on the current
> node runtime.** The instant a frozen old delegate WASM can no longer
> deserialize what the current runtime sends it — typically after a
> **freenet-stdlib / ABI bump** that changes the bincode layout of
> `InboundDelegateMsg` — the re-run fails and data under that key is
> **unrecoverable via automatic migration**. This is not hypothetical: River's
> V4–V6 delegates (freenet/river#204) failed every migration probe with
> `de/serialization error: Invalid size …` after an stdlib bump, and those
> entries were removed as unrecoverable — affected users had to rejoin via
> invite. Migrate promptly (don't let a generation sit unmigrated across an
> stdlib bump), and never assume an arbitrarily old WASM will still run.

### Preconditions

The carry-forward above only works if:
- **Identity is key-derived, never a delegate or contract key.** The user-facing
  handle (a room's owner key, an address) must survive the key rotation. See
  `identity-and-addressing.md`.
- **You keep an authoritative, append-only registry** of past delegate keys
  (below), and the old WASM is still registered on the node.

### Pre-Publish Safety Check

Add a migration check to your publish task that blocks when the delegate WASM changed without a migration entry. See Delta's `scripts/check-migration.sh` for a complete implementation.

### Migration Entry Registry

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

### What Happens Without This

If you deploy a new delegate WASM without migration:
- All stored signing keys are lost
- All user preferences are lost
- Users see their sites/rooms disappear
- Recovery requires the old WASM to still **run** on the node (see the fragility
  note above — a runtime/ABI bump can make even that impossible)

This happened to Delta in April 2026 and River multiple times. Design the
registry and the successor-side probe in from v1.

### Reusable tooling: `freenet-migrate`

Rather than hand-roll the registry, the `build.rs` codegen, and the backward
probe, a reusable crate — `freenet/freenet-migrate` — packages all of it (the
legacy-key registry, build-time codegen, the backward probe, the delegate
carry-forward, and the preconditions as enforced types). It is
**`freenet-migrate` 0.3.0 on crates.io** (with `freenet-migrate-build` 0.2.0):
`cargo add freenet-migrate` / `cargo add --build freenet-migrate-build`. Adopting
the build codegen is not a rewrite: `freenet-migrate-build` reads the River-style
`[[entry]]` registry above (`entry_registry`) and emits byte-array *view* consts
matching your hand-rolled `LEGACY_DELEGATES` shape (`delegate_pair_view` gives
`&[([u8; 32], [u8; 32])]` in `(delegate_key, code_hash)` order), with no runtime
dependency in views-only mode. Every build re-derives
`delegate_key == blake3(code_hash || params)` and flags a row that predates that
derivation with `irregular_key = true` (River adopted the build codegen this way
in freenet/river#434).

One caveat is specific to delegates: the node-mediated transport that reaches into
a predecessor *delegate* is still a documented stub (`TransportUnavailable`), so
the delegate secret carry-forward itself still runs the River/Delta way, with the
app carrying the export across `DelegateRequest::ApplicationMessages` round-trips
and re-running the old WASM (the mechanism above). Delegate-side entry points and a
node copy-forward primitive are future work, tracked under
[freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776). The
crate's shipped, field-deployed carry-forward today is the *contract* path:
River's UI and `riverctl` run it live (see `contract-patterns.md`).

## River Delegate Reference

See [River's chat-delegate](https://github.com/freenet/river/tree/main/delegates/chat-delegate) for a complete implementation:
- `src/lib.rs` - Entry point, message routing
- `src/handlers.rs` - Operation handlers
- `src/models.rs` - Data types
- `src/context.rs` - Context state management
- `README.md` - Detailed flow documentation
