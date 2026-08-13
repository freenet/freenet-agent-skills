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

**Implemented and usable today:**
- Store private data on behalf of users (secrets, keys, preferences)
- Send/receive messages from UIs, and from *other apps* on the same node
- Perform cryptographic operations (signing, encryption)
- **Read, write, and subscribe to contracts** — `OutboundDelegateMsg` carries
  `GetContractRequest`, `PutContractRequest`, `UpdateContractRequest` and
  `SubscribeContractRequest`, each with handlers in freenet-core
- **Request user permission** via `OutboundDelegateMsg::RequestUserInput`; the
  runtime renders the prompt. The ghostkeys delegate ships this in production
- **Run as a long-running background service.** A delegate that subscribes to a
  contract is woken by `InboundDelegateMsg::ContractNotification` whenever that
  contract's state changes, with no UI open. Core keeps a `DELEGATE_SUBSCRIPTIONS`
  registry mapping contract → interested delegates
- Message another delegate on the same node via `SendDelegateMessage`

**Still not implemented:**
- Creating other delegates from within a delegate (no such variant exists on
  `OutboundDelegateMsg`)

> This list previously described contract access, user permission and background
> tasks as "planned but not yet fully implemented", which contradicted SKILL.md
> and steered readers away from the subscription-driven background-service
> pattern that core actually supports. Verified against freenet-stdlib
> `delegate_interface.rs` and freenet-core.

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

## Depending on Someone Else's Delegate (consumer side)

> **Working on an app that already exists? Check this first.**
>
> ```bash
> # Any of these hits means the app will break silently on the next re-key.
> grep -rniE "delegate_key|DELEGATE_KEY|delegate_code_hash|ghostkeys.*delegate" \
>     --include=*.ts --include=*.js --include=*.rs --include=*.json \
>     --include=*.toml . | grep -v node_modules
> ```
>
> A hit in a build config, a generated constants file, or a `vite.config` /
> `build.rs` define is the pattern that breaks. Replace it with a runtime fetch
> (below). This is not theoretical — it silently broke every ghostkeys
> integration and was found by a confused user, not by any test.

Everything below about migration is written from the *author's* side: your
delegate re-keys, so migrate your users' secrets forward. There is a second,
easily-missed half — **you are a consumer of other people's delegates too**, and
their re-keys break you in a way no migration fixes.

**Do not hardcode another project's delegate key into your build.**

The key is `BLAKE3(BLAKE3(wasm) || params)`, so it changes whenever that
delegate changes — including for a bare version bump, which alters the WASM
without altering behaviour. When it changes:

- *Their* users' secrets migrate forward automatically, if that project did its
  job. That problem is solved.
- *Your app's reference does not migrate.* It is a build-time constant. After a
  re-key it addresses a namespace that is now empty.

The failure is silent and misleading. Every request comes back as though the
user simply has nothing stored — not as an error. Your error handling cannot
help, because at the protocol level "the user has no data" and "the delegate you
named no longer exists" look identical.

This is not hypothetical. The ghostkeys delegate was re-keyed twice in one day.
Every integration broke, and the first anyone knew was a user reporting that
their Ghost Key worked in the vault but not elsewhere — the app had told them to
go and buy one they already owned
([freenet/ghostkeys#21](https://github.com/freenet/ghostkeys/issues/21)).

### What to do instead

**Fetch the current key at runtime from something whose address is stable.**

The pattern ghostkeys uses, and a good default: the project publishes its
current delegate key as a file inside its own **webapp bundle**, and you fetch
it. A webapp contract's id is derived from the web container WASM and its
parameters — both fixed — so publishing a new version updates the contract's
*state*, not its key. The id survives every update of the thing it points at.

```js
const VAULT = 'DLog47hEsrtuGT4N5XCeMBG45m4n1aWM89tBZXue2E1N';  // ghostkeys vault
const { delegate_key_bytes, code_hash_bytes } =
  await (await fetch(`/v1/contract/web/${VAULT}/delegate-key.json`)).json();
```

This works from inside a sandboxed webapp: the gateway serves bundle files with
`Access-Control-Allow-Origin: *`, and the sandbox CSP permits `connect-src` to
the gateway origin. (Verified from an opaque-origin frame — `localStorage`
throws there, and the fetch still returns 200.)

Three rules that matter:

- **Re-fetch on load, cache only for the session.** Persisting it recreates the
  problem with extra steps.
- **On a failed fetch, do not fall back to a stored key.** The webapp and the
  delegate are published together, so a node lacking one almost certainly lacks
  the other. "Not available on this node" is the honest reading.
- **You still hardcode one constant** — the webapp contract id. That is a
  smaller exposure, not zero: it would move if the *web container contract*
  were upgraded, which is a much larger and more visible event than a delegate
  re-key.

### Reading delegate errors on the client

The client-side `DelegateError` (from `freenet-stdlib`, distinct from the
`DelegateError` your delegate's `process` returns) is what tells you *why* a
request did not work. Two variants are worth branching on:

| Variant | Means | What to do |
|---|---|---|
| `Missing(key)` | that delegate is **not registered** on this node | almost always a stale hardcoded key. Tell the user the app needs updating, and tell yourself — this is not "the user has no data" |
| `ExecutionError(msg)` | includes rate limiting after repeated failures | transient. Back off and retry; the message carries the delay |

**Do not treat `Missing` as proof the user has nothing stored.** It is not,
for a reason that survives even a correct client: `UnregisterDelegate` removes
a delegate's code while leaving its secrets in place, so a node can report "no
such delegate" while still holding data under it.

**Version note.** Up to and including freenet-core **v0.2.119**, the websocket
layer also emitted `Missing` when throttling a client after repeated failures,
so on those nodes the two are indistinguishable and you should not branch on it
at all. Fixed in
[freenet-core#5146](https://github.com/freenet/freenet-core/pull/5146) — from
the following release, `Missing` means only "not registered".

That overloading is exactly why the ghostkeys breakage was so hard to diagnose:
the app's error handling was correct and still produced a misleading message,
because the protocol gave it nothing to distinguish an app that needed updating
from a user who had never bought a key.

### If you publish a delegate others depend on

Then your delegate key is a **public API**, whether or not you meant it to be.
Publish the current one somewhere fetchable, in the same operation that changes
it, so the pointer cannot drift from what it points at. Gate the publish on the
two agreeing. And batch version bumps with functional changes — a bump alone
re-keys the delegate and breaks every consumer for nothing.

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
**`freenet-migrate` 0.6.0 on crates.io** (with `freenet-migrate-build` 0.2.0):
`cargo add freenet-migrate` / `cargo add --build freenet-migrate-build`. 0.6.0 is
breaking on the **contract** half only (silence is no longer read as absence; see
`contract-patterns.md`); the delegate surface is unchanged from 0.5.0. Adopting
the build codegen is not a rewrite: `freenet-migrate-build` reads the River-style
`[[entry]]` registry above (`entry_registry`) and emits byte-array *view* consts
matching your hand-rolled `LEGACY_DELEGATES` shape (`delegate_pair_view` gives
`&[([u8; 32], [u8; 32])]` in `(delegate_key, code_hash)` order), with no runtime
dependency in views-only mode. Every build re-derives
`delegate_key == blake3(code_hash || params)` and flags a row that predates that
derivation with `irregular_key = true` (River adopted the build codegen this way
in freenet/river#434).

The delegate half is shipped and has adopters. `migrate_delegate_secrets`
and `register_delegate_with_migration` (the `delegate_migrate` module) are the
app-facing entry points, and River, Delta and ghostkeys all drive them on `main`
at 0.5.0. Delegate secrets still have no core-level equivalent and never will;
see the next section for the full history and current guidance.

For the call-site swap itself in an app that already hand-rolls a sweep, see the
`freenet-migrate-adoption` skill.

## Delegate secret migration: no core mechanism, and why

A node-level copy-forward was designed and shipped:
`DelegateRequest::RegisterDelegateWithPredecessors` (freenet-core#4908, merged
2026-07-22), an origin-authorized copy of a predecessor's secrets performed by
the node at registration time. It was then **found forgeable and disabled**
(freenet-core#5199, merged 2026-08-05): predecessor delegate keys are publicly
derivable and a malicious web app *is* the client, so there was no sound way
for the node to verify that a requester actually owned the predecessor's
secrets rather than merely knowing its key. The wire variant was subsequently
removed from freenet-stdlib `main` (freenet-stdlib#91, merged 2026-08-06,
version bumped to 0.9.0) — but **0.9.0 is unreleased as of 2026-08-09**:
crates.io's latest is **0.8.5**, which still carries the variant, and
freenet-core still pins 0.8.5. What protects production nodes today is
#5199's call-site disable, not the wire removal. Check crates.io before
pinning 0.9.0 — at the time of writing it is not published there. The
underlying `SecretsStore::migrate_secrets`
machinery is left in place but uncalled (its docstring reads "UNREACHABLE FROM
PRODUCTION").

**Three trust-model designs have now been tried and rejected:** a
consent-based flow, rejected in design (client consent cannot gate the copy
when the malicious app is the client); a first-writer-wins origin record,
which *shipped* as #4908's gate and was disproven in production by #5199; and
a third routing trust through the pointer-contract author key, rejected in
adversarial review (2026-08-09) because it substitutes "is this a legitimate
code successor" for "does this requester own *this* predecessor's user
secrets", and makes author-key compromise catastrophic rather than contained.

**The decision is settled, not pending** (freenet-core#2776, 2026-08-09): no
further effort on a node-level mechanism. **Migration happens at the app
level — permanently, as standing policy, not as an interim measure.** Do not
propose or wait for a node-level copy-forward; design as though one will
never exist.

**App-level does not mean bespoke-per-app.** The goal is shared, reusable
app-side tooling, the same way `freenet-migrate` already serves contract
state, and that tooling now exists and has adopters. Use it rather than
hand-rolling another copy of the same sweep.

- **`freenet-migrate` packages this probe app-side** (0.6.0 on crates.io; the
  delegate entry points below have been stable since 0.5.0):
  `migrate_delegate_secrets` and `register_delegate_with_migration` in
  `delegate_migrate.rs`, over two adapters you implement for your client:
  `PredecessorSecretsIo` reads the predecessors, and `SuccessorSecretsIo`
  writes the successor. **River, Delta and ghostkeys all drive it on `main`.**
  River and Delta run the crate's walk alongside their existing hand-rolled
  sweep, which stays authoritative until the walk field-validates, so expect
  that staging rather than a single cutover.
  ghostkeys' adoption is the shape to copy: the crate took over the walk
  (which predecessors, newest-first, the executability preflight, marker
  bookkeeping, cross-generation selection) while the app kept every
  app-specific judgement in its adapter.
- **The successor adapter is the load-bearing part of 0.5.0.** Before it, the
  crate copied raw `(key, value)` pairs into a `SecretStore`, which is wrong
  for any app whose stored items have cross-entry invariants and fails
  silently: a recovered credential lands in the store while the index the UI
  reads never learns about it. Route the write through your app's own import
  handler. `SecretStoreIo` keeps the old raw-pair behaviour in one line for
  apps whose secrets genuinely stand alone, behind a deliberately loud ack.
- **The field evidence comes from the adopters, not from the crate's own
  tests.** The crate's own tests all drive mocked I/O; there is no integration
  test against a real node or a real WASM delegate. Both ghostkeys and Delta gated
  their adoption on a differential test against their prior hand-rolled sweep,
  which is the check worth copying.

One limitation to name either way: there is **no user consent in this flow**,
only app-author self-assertion. That is sound *at this trust boundary* — the
caller is your own compiled client code inside your own trust boundary, not a
network-reachable RPC any client can hit, which is exactly why the node-level
version failed and this does not. But it is a deliberate choice, so make it
knowingly.

**What NOT to rely on:** River's per-room identity key (`self_sk`) currently
survives delegate re-keys only *by accident* — it lives inside the
generically-indexed `RoomData` blob (`room:<vk>`), which the ordinary
migration probe already walks for unrelated reasons. It is not a deliberate
secret-migration mechanism: moving `self_sk` into its own dedicated,
non-indexed secret — the pattern the `signing_key:` secret already uses —
would silently stop migrating it at the next release. (No contradiction with
the carry-forward described above: the `signing_key:` secret itself is never
*exported* from the old delegate, because the private key never leaves it and
it is not in the walked index. What `migrate_signing_key` does is **re-seed**
the new delegate's copy from `RoomData.self_sk` — so the key survives via
`RoomData`, not via the `signing_key:` namespace.) See
[freenet/river#612](https://github.com/freenet/river/issues/612). Design your
delegate's secret layout so anything that must survive a re-key is
*deliberately* covered by your registry/enumeration probe, never incidentally
along for the ride inside something else.

Canonical, live-maintained status for this and the related addressing/pointer
and contract-state-migration problems:
[freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776).

## River Delegate Reference

See [River's chat-delegate](https://github.com/freenet/river/tree/main/delegates/chat-delegate) for a complete implementation:
- `src/lib.rs` - Entry point, message routing
- `src/handlers.rs` - Operation handlers
- `src/models.rs` - Data types
- `src/context.rs` - Context state management
- `README.md` - Detailed flow documentation
