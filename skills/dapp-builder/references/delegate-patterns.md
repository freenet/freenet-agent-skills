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

### The Solution: Export Handler from Day One

Every delegate MUST include a handler that exports all stored secrets from v1. The UI orchestrates migration between old and new delegates.

```rust
// MUST be in the delegate from the very first version
DelegateRequest::ExportSecrets { authorization } => {
    // Verify the authorization is signed by the app author
    let author_pubkey = ed25519_dalek::VerifyingKey::from_bytes(&AUTHOR_PUBKEY)?;
    let new_delegate_hash = &authorization.new_delegate_hash;
    author_pubkey.verify_strict(new_delegate_hash, &authorization.signature)
        .map_err(|_| "unauthorized migration request")?;

    // Return all secrets
    let signing_key = ctx.get_secret(b"signing_key");
    let user_data = ctx.get_secret(b"user_data");
    DelegateResponse::ExportedSecrets {
        signing_key,
        user_data,
    }
}
```

### Migration Flow

1. **Build time:** Build new delegate WASM, compute its hash
2. **Build time:** App author signs the new WASM hash (embedded in UI, not delegate)
3. **Runtime:** UI sends `ExportSecrets` to old delegate with signed authorization
4. **Runtime:** Old delegate verifies signature against hardcoded author pubkey
5. **Runtime:** Old delegate returns secrets
6. **Runtime:** UI stores secrets in new delegate via `StoreSigningKey` etc.

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

The UI's `build.rs` generates a Rust constant array from this file, which the migration code uses to probe old delegates at startup.

### What Happens Without This

If you deploy a new delegate WASM without migration:
- All stored signing keys are lost
- All user preferences are lost  
- Users see their sites/rooms disappear
- Recovery requires the old WASM to still be on the node AND to support export

This happened to Delta in April 2026 and River multiple times. Ship the export handler from v1.

## River Delegate Reference

See [River's chat-delegate](https://github.com/freenet/river/tree/main/delegates/chat-delegate) for a complete implementation:
- `src/lib.rs` - Entry point, message routing
- `src/handlers.rs` - Operation handlers
- `src/models.rs` - Data types
- `src/context.rs` - Context state management
- `README.md` - Detailed flow documentation
