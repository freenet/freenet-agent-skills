# Delegate Patterns

Delegates are WebAssembly agents that run locally on the user's device within freenet-core. They act as a "trust zone" for private operations.

## DelegateInterface Trait

Every delegate must implement this trait from `freenet-stdlib`:

```rust
use freenet_stdlib::prelude::*;

struct MyDelegate;

#[delegate]  // Generates WASM FFI boilerplate
impl DelegateInterface for MyDelegate {
    /// Process inbound messages, return outbound messages
    fn process(
        ctx: &mut DelegateCtx, // secrets and the synchronous host calls
        parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError>;
}
```

## Delegate Capabilities

**Available to a delegate:**
- Store private data on behalf of users (secrets, keys, preferences) through
  `DelegateCtx::get_secret` / `set_secret` / `has_secret` / `remove_secret` /
  `list_secrets`
- Send/receive messages from UIs, and from *other apps* on the same node
- Perform cryptographic operations (signing, encryption)
- **Request user permission** via `OutboundDelegateMsg::RequestUserInput`. The
  node's `DashboardPrompter` renders the prompt, opening the permission page in
  the user's browser if no dashboard tab is connected. The ghostkeys delegate
  ships this in production
- Message another delegate on the same node via `SendDelegateMessage`
- **Create a child delegate at runtime** via `DelegateCtx::create_delegate`, a
  host function rather than an `OutboundDelegateMsg`

**Contract access is by message, on a network node at v0.2.139 or later.** Emit the
`OutboundDelegateMsg` and handle the paired response. What each verb reaches
differs:

| Verb | Local | Network |
|---|---|---|
| `GetContractRequest` | reads the local store | on a local miss, a real GET |
| `PutContractRequest` | stores | broadcast to peers already interested. No routing PUT |
| `UpdateContractRequest` | applies | same broadcast as PUT |
| `SubscribeContractRequest` | registers the notification hook | a real subscription that counts as local demand, persisted and restored at node start (at most 512 pairs per boot) |

- **Read an empty GET as "could not get it", never "does not exist".**
  `GetContractResponse` has no error channel, so a refusal, a network `NotFound`
  and an unreachable network are all `state: None`. A run gets 4 network
  operations (`MAX_NETWORK_CONTRACT_OPS_PER_PARK`), shared by GET, SUBSCRIBE and
  UPDATE's background fetch. Past that a GET is refused.
- **`ctx.get_contract_state` is local only.** Use it as a cheap "do I hold this?"
  probe. `None` means "not held here". Use `GetContractRequest` when you need the
  network asked.
- **A delegate PUT does not place a contract.** Nothing is routed toward the key,
  so the contract does not become findable by key. It reaches peers already
  interested, and those that take an interest later. Publish a new contract from
  a client.
- **UPDATE takes only `UpdateData::State` and `UpdateData::Delta`.** Other variants
  return `Err("Unsupported UpdateData variant")`. The contract must also resolve
  locally: otherwise it returns `Err`, possibly with a background fetch started.
  GET or SUBSCRIBE first.
- **A subscription is demand, not an eviction exemption.** It lasts until
  `UnregisterDelegate`, contract removal or notification channel close, and it can
  be displaced by the per-delegate cap or by eviction on an over-budget node. No
  inactivity horizon exists (freenet-core#4669).
- **Do not emit `UnsubscribeContractRequest`.** The SDK has it and the node does
  not: it fails the whole delegate run (freenet-core#5600). The only exits are
  `UnregisterDelegate` and cap eviction.

**Notifications.** A subscribed delegate is notified on a local state commit. Two
limits:

- Delivery is best-effort: a bounded channel, dropped when full. A delegate that
  needs certainty also polls.
- Writes made while the node was down are not replayed. Re-read the contract after
  a restart, for example on a `NodeStarted` lifecycle run (see
  [Background runs](#background-runs-manifest-lifecycle-events-and-wake-ups)).

## Background runs: manifest, lifecycle events and wake-ups

A delegate that must act with no tab open declares it in a **manifest**, a JSON
custom section the `#[delegate]` macro writes into its WASM and the node reads
at registration without running any code:

```rust
#[delegate(manifest(
    lifecycle = [Installed, NodeStarted],
    capabilities = [Background],
    wakeups = [heartbeat = 300],   // tag = interval in seconds
))]
impl DelegateInterface for MyDelegate { /* ... */ }
```

- **Lifecycle events** (freenet-stdlib 0.12.0, node v0.2.138+) arrive as `InboundDelegateMsg::Lifecycle(..)`:
  `Installed` at most once per delegate key per node, and
  `NodeStarted { down_since_ms }` once per node start. `down_since_ms` is
  always `None` today: the node does not record when it last ran.
- **Periodic wake-ups** (freenet-stdlib 0.12.1 / freenet-macros 0.3.1, node
  v0.2.139+) arrive as `InboundDelegateMsg::WakeupFired { tag }`. The node clamps the
  interval to 60 s..7 days (`MIN_WAKEUP_INTERVAL_SECS` /
  `MAX_WAKEUP_INTERVAL_SECS`), honours tags of 1..=64 bytes, the first entry
  per tag and at most 4 entries; the macro makes an out-of-range, duplicate or
  fifth entry, or wake-ups without `Background`, a compile error. Wake-ups are
  **re-armed at node start, not persisted**: missed fires are not replayed, and
  a fire that cannot start within 45 s (delegate busy, budget spent) is skipped
  while the schedule continues. `WakeupFired` carries no `DelegateContext`;
  keep state that must survive between fires in secrets.
- **Consent.** Nothing is delivered until the user grants the registering app
  `Background`, which the node asks for once, at registration, with a
  node-authored prompt. The grant and the manifest are re-checked at every
  delivery, so revoking stops it. Capabilities are disabled on a hosted-mode
  node.
- **What such a run can do.** It gets the delegate's registered parameters and
  no origin. Contract GET/PUT/UPDATE/SUBSCRIBE, secrets and app messages to open
  tabs work; its contract operations and loop time are charged to one duty
  budget shared by lifecycle and wake-up runs. It **cannot message another
  delegate**: the inter-delegate hop is suppressed for every unprompted run.
- **One build for old and new nodes.** A node that predates wake-ups skips the
  unknown `wakeups` field and still honours the rest of the manifest. Such a
  node asks for `Background` only when a lifecycle kind is listed, so list one
  (e.g. `NodeStarted`) alongside `wakeups`.
- **Keep the section.** Adding or changing a manifest changes the WASM, and so
  the delegate key. Post-processing that strips custom sections (`wasm-strip`,
  `wasm-opt --strip-*`) removes it, and a missing section silently means "no
  manifest".
- **Not under `freenet local`.** The capability machinery is built by the
  network node's runtime pool and run on its contract loop, which `freenet
  local` does not run (see the next section).

## `freenet local` Does Not Run the Delegate Contract Loop

Under `freenet local` a delegate's `GetContractRequest`, `PutContractRequest`,
`UpdateContractRequest` and `SubscribeContractRequest` get no response, write no
state and register no subscription, and nothing reports an error. `process()`
runs and its outbound messages are not acted on. `RequestUserInput`, contract
notifications, lifecycle events and wake-ups are lost the same way
(freenet-core#5273). `DelegateCtx::get_contract_state` is the exception: it is a
host call, so local reads work.

**Test a delegate's contract access against a real node.** This is the shape that
passes a local test and fails in production.

## What a Delegate Is Not Good For Yet

- **Background work that needs another delegate.** See "Only a client-driven run
  can message another delegate" below.
- **Knowing what it is subscribed to.** There is no introspection API, so a
  delegate has nothing to reconcile against after a restart (freenet-core#5467).

## Message Types

Both enums live in freenet-stdlib `rust/src/delegate_interface.rs`.

### Inbound Messages

```rust
/// Host -> delegate. `#[non_exhaustive]`, so a `match` needs a wildcard arm.
#[non_exhaustive]
pub enum InboundDelegateMsg<'a> {
    ApplicationMessage(ApplicationMessage),
    UserResponse(UserInputResponse<'a>),
    GetContractResponse(GetContractResponse),
    PutContractResponse(PutContractResponse),
    UpdateContractResponse(UpdateContractResponse),
    SubscribeContractResponse(SubscribeContractResponse),
    ContractNotification(ContractNotification),
    DelegateMessage(DelegateMessage),
    UnsubscribeContractResponse(UnsubscribeContractResponse),
    // Wire tag 9. Delivered only to a delegate whose manifest declares
    // `wakeups` (stdlib 0.12.1, freenet-core v0.2.139+).
    WakeupFired { tag: Vec<u8> },
    // Wire tag 10 (stdlib 0.12.0). Delivered only for a lifecycle kind the
    // delegate's manifest lists (freenet-core v0.2.138+).
    Lifecycle(LifecycleEvent),
}
```

### Outbound Messages

```rust
/// Delegate -> host. NOT `#[non_exhaustive]`: adding a variant here breaks
/// every delegate that matches exhaustively on it.
pub enum OutboundDelegateMsg {
    ApplicationMessage(ApplicationMessage),
    RequestUserInput(UserInputRequest<'static>),
    ContextUpdated(DelegateContext),
    GetContractRequest(GetContractRequest),
    PutContractRequest(PutContractRequest),
    UpdateContractRequest(UpdateContractRequest),
    SubscribeContractRequest(SubscribeContractRequest),
    SendDelegateMessage(DelegateMessage),
    // Present in the SDK, NOT implemented by the node: emitting it fails the
    // delegate run (freenet-core#5600).
    UnsubscribeContractRequest(UnsubscribeContractRequest),
}
```

## Host Functions on `DelegateCtx`

Contract work is by message: `process()` returns e.g. `GetContractRequest` and
the host re-invokes it with `GetContractResponse`. The loop stops at
`MAX_CONTRACT_REQUEST_ITERATIONS` (100). Past that the delegate is not
re-invoked and the client gets a truncated result with no failure signal
(freenet-core#5454).

Synchronous calls: secrets (`get_secret`, `set_secret`, `has_secret`,
`remove_secret`, `list_secrets`), context (`read`, `write`, `clear`), and two
that reach outside the delegate:

```rust
ctx.get_contract_state(&instance_id)             // -> Option<Vec<u8>>, local state only
ctx.create_delegate(wasm, params, cipher, nonce) // -> Result<([u8; 32], [u8; 32]), i32>
```

### Removed: do not reach for these

| removed wrapper | what to emit instead |
|---|---|
| `ctx.put_contract_state` | `OutboundDelegateMsg::PutContractRequest` |
| `ctx.update_contract_state` | `OutboundDelegateMsg::UpdateContractRequest` |
| `ctx.subscribe_contract` | `OutboundDelegateMsg::SubscribeContractRequest` |
| `ctx.subscribe_contract_checked` | `OutboundDelegateMsg::SubscribeContractRequest` |
| `ctx.list_subscriptions` | *nothing: no node implemented it* |
| `ctx.schedule_wakeup` | a `wakeups` entry in the delegate manifest (stdlib 0.12.1, freenet-core v0.2.139); see [Background runs](#background-runs-manifest-lifecycle-events-and-wake-ups) |

**WASM built against stdlib 0.10.0 or earlier keeps its imports.** A delegate that
calls one of these fails at module instantiation on a v0.2.136+ node, after
publishing, on a node that stays healthy while the app is dead. A delegate that
only emits the message verbs is fine on every stdlib version, 0.8.5 included.
Rebuilding against 0.11.0 turns the failure into a compile error.

## Resource Limits

Per invocation:

- **Time:** 5 s (`max_execution_seconds`), enforced by wasmtime epoch interruption
  with a wall-clock backstop. A runaway guest is killed, not paused.
- **Memory:** 256 MiB.
- **Fuel metering is off in production.** Do not reason about cost in fuel.

Across invocations, by count:

- **Child delegates:** depth 4, 8 per `process()` call, 1024 per node, 10 MiB WASM.
- **Contract subscriptions:** 256 per delegate. A new one past the cap evicts the
  coldest.
- **App registrations:** 128 per delegate (off-host clients up to 96) and 256
  delegates per client, held for the connection's life. The 129th concurrent
  connection to one delegate is refused silently: that app gets direct replies
  but no pushes.

Unprompted runs of a delegate whose app holds the Background grant are budgeted.
Loop time is charged to a per-delegate duty balance (1% of wall time, 10 s burst)
and, for lifecycle and wake-up runs, a node-wide one (10%, 30 s burst). A spent
balance defers lifecycle and wake-up runs; notification runs are charged but not
deferred. Contract operations are admitted at 300/min per delegate, 3000/min per
node and 60 writes/min per (delegate, contract). A refused GET reads as not found.

Do not design as though these were bounded: CPU and memory across many cheap
client-driven calls, or a delegate that panics or spins on every invocation (no
quarantine or circuit breaker yet, freenet-core#5467). There is no per-delegate
observability; the only counters are node-wide background-run totals at
`GET /permission/grants`.

## Inter-delegate messaging

`DelegateInterface::process()` receives an `Option<MessageOrigin>`. When one delegate messages another via `OutboundDelegateMsg::SendDelegateMessage`, the runtime attests the caller's identity so the receiver can make authorization decisions.

The `MessageOrigin` enum has two variants today:

- `MessageOrigin::WebApp(ContractInstanceId)` — the message was sent by a web application backed by the given contract.
- `MessageOrigin::Delegate(DelegateKey)` — the message was sent by another delegate. The carried key is the runtime-attested identity of the calling delegate.

```rust
match origin {
    Some(MessageOrigin::WebApp(id)) => { /* called from contract UI */ }
    Some(MessageOrigin::Delegate(id)) => { /* called from another delegate, verify id whitelist */ }
    None => { /* unattested — treat as untrusted */ }
    // MessageOrigin is #[non_exhaustive]
    _ => { /* future variants */ }
}
```

**Security note:** Do not trust `MessageOrigin::Delegate` for sensitive operations unless you whitelist the caller's `DelegateKey`. Per the stdlib docs, an inter-delegate message *replaces* rather than composes with any inherited `WebApp` origin the calling delegate may itself hold — the receiver sees only `Delegate(caller_key)` for the duration of the call and does not gain contract access on behalf of any web app the caller was acting for. Authorize on the calling delegate's identity alone.

**Only a client-driven run can message another delegate.** A
`SendDelegateMessage` emitted from a run the node started on its own is
dropped, with only an `info` log line. That covers contract-notification,
lifecycle and wake-up runs. Delivery from a client-driven run is single-hop: the
target's own `SendDelegateMessage`s are filtered out.

## Check the Origin at the Boundary, Not Per Handler

**A delegate's address is public and its secrets are not.** The key is
`BLAKE3(BLAKE3(wasm) || params)` over a WASM you probably committed, so anyone
can compute it, and any web app the user has ever opened on that node can send
it an `ApplicationMessage`. Reading `origin` is the entire access control.

The failure mode is not "we forgot to check". It is **"we checked in every
request family that existed at the time"**. A payment-hijack hole in one app
existed because a third request family was added past the one function that held
the origin check — the two older families were still gated, the code looked
consistent, and the new one answered anybody.

So put the check where every request must pass it, before dispatch:

```rust
use freenet_migrate::OriginPolicy;

fn authorize(origin: Option<&MessageOrigin>) -> Result<(), DelegateError> {
    // `OriginPolicy::authorize` returns MigrateError, and there is no
    // From<MigrateError> for DelegateError -- map it, and name the refused
    // caller so a developer reading a node log can act on it.
    OriginPolicy::SameWebApp(my_webapp_contract_id())
        .authorize(origin)
        .map_err(|_| DelegateError::Other(format!("refused caller: {origin:?}")))
}

// The real trait signature is four parameters, `ctx` first
// (freenet-stdlib rust/src/delegate_interface.rs).
fn process(
    ctx: &mut DelegateCtx,
    _params: Parameters<'static>,
    origin: Option<MessageOrigin>,
    message: InboundDelegateMsg,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    // One gate, ahead of the match. A request family added later cannot
    // route around it without deleting this line.
    authorize(origin.as_ref())?;
    match message { /* ... */ }
}
```

`freenet-migrate` exposes the policy type rather than making you hand-roll the
comparison: `OriginPolicy::SameWebApp(ContractInstanceId)` /
`FromDelegate(DelegateKey)` / `Any`, whose `authorize(Option<&MessageOrigin>)`
**fails closed on `None`** for both real policies. The runtime supplies `None`
when it cannot attest a caller, which includes every off-host connection, and
that is not a caller to hand a private key to. (`Any` accepts an unattested
caller and is documented in the crate as unsafe, for local testing only.) Use
the policy for ordinary requests as well as for the migration export it was
written for. A second, hand-rolled comparison beside it is how the two drift
apart and one ends up weaker.

Refuse with an error rather than an empty success. A rejected caller that gets
`Ok(vec![])` looks, to a legitimate page hitting this unexpectedly, exactly like
a request that worked, and the first symptom is a user wondering why nothing
saved.

### Take `impl SecretStore`, not `DelegateCtx` — or you cannot test any of this

`DelegateCtx`'s secret methods are **inert off `wasm32`**: the
`#[cfg(not(target_family = "wasm"))]` arms in freenet-stdlib's
`delegate_host.rs` return `None` from `get_secret`, `false` from `set_secret`
and `remove_secret`, and an empty `Vec` from context reads. A handler that takes
a `DelegateCtx` therefore cannot be exercised under `cargo test` at all — every
read misses and every write is refused, so a test can only ever observe the
failure path.

That is why the hole above had no test. The only statement a test could make
about the affected handler was "it returned something", never "the seller's
payment key is still the seller's".

Take a trait instead and let the tests hold a real in-memory store:

```rust
use freenet_migrate::SecretStore;  // list_secrets / get_secret / has_secret / set_secret

fn handle_request(store: &mut impl SecretStore, req: Request) -> Result<Reply, Error> { /* ... */ }

// Production: pass the ctx. freenet-migrate impls SecretStore for DelegateCtx
// under `#[cfg(all(feature = "delegate", target_family = "wasm"))]`, so the
// bridge only exists where the FFI symbols do -- which is exactly why native
// tests need their own impl rather than a stub of the real one.
// Tests: a BTreeMap-backed impl, so a hostile request can be run against a
// populated store and the assertion is on the bytes still in it afterwards.
```

Reuse `freenet-migrate`'s `SecretStore` rather than defining a parallel one if
you already depend on the crate for migration — one vocabulary for "the
delegate's secret store" across the crate. Note it has no `remove`; if you need
genuine deletion (`DelegateCtx::remove_secret`), that takes an extra trait of
your own, and it is a native stub too, so what your tests can state is that your
code *asks* for removal, not that the node performed it.

## Worked patterns

```rust
const SIGN_PROMPT: u32 = 1;

// A delegate serving several apps needs the caller's id, so it matches the
// origin itself. A delegate serving one app uses `authorize` above.
fn app_of(origin: Option<&MessageOrigin>) -> Result<ContractInstanceId, DelegateError> {
    match origin {
        Some(MessageOrigin::WebApp(id)) => Ok(*id),
        other => Err(DelegateError::Other(format!("refused caller: {other:?}"))),
    }
}

fn process(
    ctx: &mut DelegateCtx,
    _params: Parameters<'static>,
    origin: Option<MessageOrigin>,
    message: InboundDelegateMsg,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    match message {
        InboundDelegateMsg::ApplicationMessage(msg) => {
            let app = app_of(origin.as_ref())?;
            // A delegate's secret namespace is shared by every app using it.
            // Prefix keys with the origin to isolate apps.
            let key = format!("{app}:user_data");
            if !ctx.set_secret(key.as_bytes(), &msg.payload) {
                return Err(DelegateError::Other("secret store refused the write".into()));
            }
            let reply = ApplicationMessage::new(b"stored".to_vec()).processed(true);
            Ok(vec![OutboundDelegateMsg::ApplicationMessage(reply)])
        }
        InboundDelegateMsg::UserResponse(r) if r.request_id == SIGN_PROMPT => {
            let allowed = &*r.response == b"Allow".as_slice();
            // ...sign, or refuse...
            Ok(vec![])
        }
        InboundDelegateMsg::GetContractResponse(r) => {
            let pending: &[u8] = r.context.as_ref(); // what the request carried
            // ...r.state is Option<WrappedState>...
            Ok(vec![])
        }
        _ => Ok(vec![]), // InboundDelegateMsg is #[non_exhaustive]
    }
}

// Ask the user. Unanswered prompts auto-deny after 60 s.
fn ask() -> OutboundDelegateMsg {
    let message = NotificationMessage::try_from(&serde_json::json!("Allow this app to sign?"))
        .expect("a JSON string always encodes");
    OutboundDelegateMsg::RequestUserInput(UserInputRequest {
        request_id: SIGN_PROMPT,
        message,
        responses: vec![
            ClientResponse::new(b"Allow".to_vec()),
            ClientResponse::new(b"Deny".to_vec()),
        ],
    })
}

// A request carries its own continuation.
fn read_contract(contract_id: ContractInstanceId, pending: Vec<u8>) -> OutboundDelegateMsg {
    let mut req = GetContractRequest::new(contract_id);
    req.context = DelegateContext::new(pending);
    OutboundDelegateMsg::GetContractRequest(req)
}
```

- Encode a binary origin before using it in a key. A lossy UTF-8 conversion maps
  every invalid byte to U+FFFD, so distinct keys alias.
- Delegates hold no state between calls. Carry a continuation in the `context`
  field of the request. `ctx.read()` / `ctx.write()` hold one entry per delegate,
  shared by every run on the node and dropped after 10 minutes, so anything that
  must outlive one exchange goes in secrets.

## DelegateKey Anatomy (CRITICAL)

A `DelegateKey` has **two separate fields**. Confusing them causes silent failures where the node cannot find the delegate.

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

**`CodeHash::from_code` hashes its input; `CodeHash::new` wraps 32 bytes.** Passing
an existing hash to `from_code` gives `BLAKE3(BLAKE3(wasm))`.

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

## Depending on Someone Else's Delegate

Never hardcode another project's delegate key: it moves on every re-key of
theirs, including a bare version bump. See `building-on-other-apps.md`.

## Optional: back up contract state in a delegate

A contract your app depends on can drop off the network if nothing keeps it
hosted. An app that cannot afford that can keep a copy in its delegate, as
[Delta](https://github.com/freenet/delta) does in
`ui/src/freenet_api/delegate.rs`: store the state as a secret after each GET or
UPDATE response, and when a GET times out or returns `NotFound`, read the copy
back and PUT it to restore the contract.

- A re-PUT must still pass the contract's `validate_state`. A backup carries no
  extra authority, and a copy the contract now rejects restores nothing.
- Merge a restored copy into anything newer rather than replacing it, so a stale
  backup cannot bring back a deleted record.
- A backup is a secret like any other, so it stays under the old delegate key
  until migration moves it.

## Delegate WASM upgrades

When delegate WASM changes, the delegate key changes, and secrets stored under
the old key become inaccessible to the new delegate. Plan for this from v1. See
`delegate-migration.md`.

## River Delegate Reference

See [River's chat-delegate](https://github.com/freenet/river/tree/main/delegates/chat-delegate) for a complete implementation:
- `src/lib.rs` - Entry point, message routing
- `src/handlers.rs` - Operation handlers
- `src/models.rs` - Data types
- `src/context.rs` - Context state management
- `README.md` - Detailed flow documentation
