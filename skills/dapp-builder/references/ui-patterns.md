# UI Patterns

The UI is the interaction layer that connects to the Freenet Kernel via WebSocket/HTTP. River uses Dioxus (Rust), but you can use any web framework. This document covers both Dioxus and TypeScript + Vite approaches.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Web Browser                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Your UI (WASM)                   │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────┐   │    │
│  │  │ Components  │  │ State Mgmt  │  │Synchronizer│   │    │
│  │  └─────────────┘  └─────────────┘  └────────────┘   │    │
│  └──────────────────────────┬──────────────────────────┘    │
└─────────────────────────────┼───────────────────────────────┘
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Freenet Kernel (Local)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │  Contracts   │  │  Delegates   │  │   Gateway    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Gateway CSP: Vendor Your Assets

The gateway sandbox iframe runs under a same-origin CSP, currently (see
`freenet-core/crates/core/src/server/client_api.rs` for the source of
truth):

```
default-src <iframe-origin> 'unsafe-inline' 'unsafe-eval' blob: data:;
connect-src <iframe-origin> blob: data:
```

Any remote `<link rel="stylesheet">` or `<script src>` from a CDN
(`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, etc.)
is blocked by `default-src`. `fetch()` / `XMLHttpRequest` to a non-same-origin
backend is blocked by `connect-src`. `dx serve` / `vite dev` run on their
own origin where the CSP doesn't apply, so the failure only surfaces after
`fdev publish`: the production webapp renders unstyled / scriptless with a
`Content Security Policy directive` violation in the browser console.

**Always vendor your assets into the webapp's asset directory** and
reference them with relative paths:

- Dioxus: drop CSS / fonts / scripts into `ui/assets/vendor/` (or wherever
  `Dioxus.toml`'s `asset_dir` points — River bundles its vendored CSS
  directly into `ui/assets/`). The release build copies that tree into the
  webapp archive.
- Vite / Webpack: import the stylesheet from `node_modules`, or copy the
  vendored files into `public/`. Don't keep a CDN URL "just for dev".

```html
<!-- Wrong: blocked by gateway CSP -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css">

<!-- Right: vendored, loaded same-origin -->
<link rel="stylesheet" href="vendor/bulma.min.css">
<link rel="stylesheet" href="vendor/fontawesome/css/all.min.css">
```

A production-liveness smoke test (see `production-smoke-testing.md`) catches
this regression by asserting `getComputedStyle(...).fontWeight` matches the
value set by your vendored stylesheet — it flips back to the user-agent
default the moment the stylesheet fails to load.

## Dioxus Setup

### Project Structure

```
ui/
├── Cargo.toml
├── Dioxus.toml
├── src/
│   ├── main.rs
│   └── components/
│       ├── app.rs
│       └── ...
├── public/
│   ├── contracts/     # WASM files
│   └── assets/
└── tailwind.config.js
```

### Cargo.toml

```toml
[package]
name = "my-dapp-ui"
version = "0.1.0"
edition = "2021"

[dependencies]
# Mirror River's pinned versions; see https://github.com/freenet/river/blob/main/ui/Cargo.toml
# stdlib bumped to 0.8 to track current freenet-stdlib release.
dioxus = { version = "0.7.3", features = ["web"] }
dioxus-free-icons = { version = "0.10.0", features = ["font-awesome-solid"] }
freenet-stdlib = { version = "0.8", features = ["net"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
web-sys = { version = "0.3", features = ["WebSocket", "MessageEvent", "Window", "Location"] }
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
# Required for wasm32-unknown-unknown; pulls crypto.getRandomValues from JS
getrandom = { version = "0.2", features = ["js", "wasm-bindgen", "js-sys"], default-features = false }

# Shared types with contract/delegate
common = { path = "../common" }

[features]
default = []
example-data = []  # Pre-populated test data
no-sync = []       # Disable network synchronization
```

### Dioxus.toml

```toml
[application]
name = "my-dapp"
default_platform = "web"

[web.app]
title = "My Freenet dApp"

[web.watcher]
reload_html = true
watch_path = ["src", "public"]

[web.resource]
dev_assets_path = "public"
assets_path = "dist"
```

## Global State Management

Use Dioxus signals for reactive state:

```rust
use dioxus::prelude::*;

// Global state accessible from any component
pub static CONTRACTS: GlobalSignal<HashMap<ContractKey, ContractState>> = Global::new(HashMap::new);
pub static CURRENT_CONTRACT: GlobalSignal<Option<ContractKey>> = Global::new(|| None);
pub static SYNC_STATUS: GlobalSignal<SyncStatus> = Global::new(|| SyncStatus::Disconnected);
pub static WEB_API: GlobalSignal<Option<WebApi>> = Global::new(|| None);

#[derive(Clone, PartialEq)]
pub enum SyncStatus {
    Disconnected,
    Connecting,
    Connected,
    Syncing,
    Error(String),
}
```

## WebSocket Connection

### Two Connection Models: Pick the Right One

A Freenet client can reach the local node over WebSocket in two different ways.
The correct choice depends on **how the client loads**, not on what it wants to do.

| Client load path | Connection model | What to do |
|------------------|------------------|-----------|
| Loaded as a **webapp via `/v1/contract/web/{key}/`** (runs inside the gateway's sandboxed iframe) | **Shell-managed WebSocket.** The gateway's outer page owns the real socket and injects the auth token. Your WASM calls `WebSocket::new(url)` and a shimmed `window.WebSocket` transparently forwards messages via `postMessage`. | Derive the URL from `window.location` (see below). **Do NOT call `Authenticate`; the shell injects it.** Use `freenet-stdlib::WebApi::start()`. |
| Loaded **outside the gateway** (native CLI, Playwright page served from a dev port like `python3 -m http.server`, a Node script, or any page that did not come from `/v1/contract/web/...`) | **Raw WebSocket.** There is no shell; you talk directly to the node's WS API. | Hardcode or configure `ws://127.0.0.1:7509/v1/contract/command?encodingProtocol=native`. After the socket opens, **send `ClientRequest::Authenticate { token }` yourself** with a token from the node's config or `~/.config/freenet/`. See the `local-dev` skill for details. |

In short: **if your code is running inside an iframe served by `/v1/contract/web/...`, the shell does auth for you.** Everywhere else, you do it yourself. Getting this wrong produces confusing symptoms: the shell model fails with "Auth token not found" if you try to authenticate manually, and the raw model hangs forever if you forget.

See also `production-smoke-testing.md` for the shell HTML structure and the
Playwright idioms (`frameLocator` / absolute-URL `goto`) needed to reach
into the iframe from E2E tests.

### CRITICAL: How WebSocket Works in the Gateway (Shell-Managed Model)

Freenet serves web apps inside **sandboxed iframes** for origin isolation.
The app does NOT create a raw WebSocket directly. Instead:

1. The **shell page** (outer frame) holds the auth token and manages the real WebSocket
2. The **sandboxed iframe** (where your WASM app runs) has `window.WebSocket` replaced
   with a postMessage-based shim (`FreenetWebSocket`)
3. When your code calls `WebSocket::new(url)`, the shim intercepts it and routes
   through postMessage to the shell page, which creates the real connection

This means:
- Your app calls `WebSocket::new()` normally (or uses `freenet-stdlib`'s `WebApi::start()`)
- The **URL must use the correct path**: `/v1/contract/command?encodingProtocol=native`
- The **URL must be derived from `window.location`**, not hardcoded, so it works on any host/port
- The shell page automatically injects the auth token -- your app does NOT need to handle auth

### WebSocket URL (IMPORTANT)

**NEVER hardcode `ws://127.0.0.1:7509`.** Derive the URL from the page location:

```rust
/// Get the WebSocket URL for connecting to the Freenet node.
/// Derives from window.location so the app works on any host/port.
#[cfg(target_arch = "wasm32")]
fn get_websocket_url() -> String {
    const FALLBACK: &str = "ws://localhost:7509/v1/contract/command?encodingProtocol=native";

    if let Some(window) = web_sys::window() {
        let location = window.location();
        let protocol = location.protocol().unwrap_or_default();
        let host = location.host().unwrap_or_default(); // includes port

        let ws_protocol = if protocol == "https:" { "wss:" } else { "ws:" };
        format!("{ws_protocol}//{host}/v1/contract/command?encodingProtocol=native")
    } else {
        FALLBACK.to_string()
    }
}
```

The full URL path is: `ws://{host}/v1/contract/command?encodingProtocol=native`

Reference: `river/ui/src/components/app/freenet_api/constants.rs`

### Connection Manager (Using freenet-stdlib WebApi)

The recommended approach is to use `freenet-stdlib`'s `WebApi::start()` which handles
binary serialization/deserialization of Freenet protocol messages:

```rust
use freenet_stdlib::client_api::{WebApi, ClientError, HostResponse};

pub async fn connect() -> Result<(), String> {
    let url = get_websocket_url();
    let websocket = web_sys::WebSocket::new(&url)
        .map_err(|e| format!("Failed to create WebSocket: {e:?}"))?;

    let web_api = WebApi::start(
        websocket,
        // Response callback
        move |result: Result<HostResponse, ClientError>| {
            match result {
                Ok(response) => handle_response(&response),
                Err(e) => log::warn!("API error: {e}"),
            }
        },
        // Error callback
        move |_error| {
            log::error!("WebSocket connection lost");
        },
        // Connected callback
        move || {
            log::info!("Connected to Freenet node");
        },
    );

    // Store web_api in a global signal for use by other components
    *WEB_API.write() = Some(web_api);
    Ok(())
}
```

**Important:** `WebApi::start()` returns immediately. The connection is established
asynchronously. Wait for the "connected" callback before sending requests.

### Dependencies for WebSocket

The UI crate needs these dependencies for WebSocket to work on `wasm32-unknown-unknown`:

```toml
freenet-stdlib = { version = "0.6.0", features = ["net"] }
# Required for wasm32-unknown-unknown: use JS crypto.getRandomValues for RNG
getrandom = { version = "0.2", features = ["js", "wasm-bindgen", "js-sys"], default-features = false }
```

Pin `freenet-stdlib` to the same version as the rest of your workspace and the
gateway you publish to. Mismatched stdlib versions between UI, CLI tools, and
the gateway are the #1 cause of "variant index out of range" bincode errors.

Without the `getrandom` js feature, `getrandom 0.2` emits a `compile_error!` on
`wasm32-unknown-unknown`. River uses this exact pattern.

## Contract Synchronization

### Subscribing to Contracts

```rust
use freenet_stdlib::client_api::{ClientRequest, ContractRequest};

pub async fn subscribe_to_contract(
    connection: &FreenetConnection,
    contract_key: ContractKey,
) -> Result<(), Error> {
    let request = ClientRequest::ContractOp(ContractRequest::Subscribe {
        key: contract_key,
        summary: None,  // Get full state initially
    });

    let bytes = serialize(&request)?;
    connection.send(&bytes)?;

    Ok(())
}
```

### Handling Updates

```rust
pub fn handle_contract_update(response: ContractResponse) {
    match response {
        ContractResponse::GetResponse { key, state, .. } => {
            // Full state received
            let contract_state: MyState = deserialize(&state)?;
            CONTRACTS.write().insert(key, contract_state);
        }

        ContractResponse::UpdateNotification { key, update } => {
            // Delta update received
            if let Some(state) = CONTRACTS.write().get_mut(&key) {
                state.apply_delta(&update.delta)?;
            }
        }

        ContractResponse::SubscribeResponse { key, .. } => {
            log::info!("Subscribed to contract: {:?}", key);
        }

        _ => {}
    }
}
```

### Sending Updates

```rust
pub async fn send_update(
    connection: &FreenetConnection,
    contract_key: ContractKey,
    delta: StateDelta,
) -> Result<(), Error> {
    let request = ClientRequest::ContractOp(ContractRequest::Update {
        key: contract_key,
        data: UpdateData::Delta(delta),
    });

    let bytes = serialize(&request)?;
    connection.send(&bytes)?;

    Ok(())
}
```

## Delegate Communication

### Registering a Delegate

```rust
use freenet_stdlib::client_api::DelegateRequest;

pub async fn register_delegate(
    connection: &FreenetConnection,
    delegate_wasm: &[u8],
    parameters: Parameters,
) -> Result<DelegateKey, Error> {
    let request = ClientRequest::DelegateOp(DelegateRequest::RegisterDelegate {
        delegate: DelegateContainer::Wasm(delegate_wasm.to_vec()),
        cipher: Cipher::Plain,  // or encrypted
        nonce: None,
    });

    let bytes = serialize(&request)?;
    connection.send(&bytes)?;

    // Wait for response with delegate key
    Ok(delegate_key)
}
```

### Sending Messages to Delegate

```rust
pub async fn send_to_delegate(
    connection: &FreenetConnection,
    delegate_key: DelegateKey,
    message: impl Serialize,
) -> Result<(), Error> {
    let payload = serialize(&message)?;

    let request = ClientRequest::DelegateOp(DelegateRequest::ApplicationMessages {
        key: delegate_key,
        params: vec![],
        inbound: vec![InboundDelegateMsg::ApplicationMessage(
            ApplicationMessage {
                app: app_contract_key(),
                payload: payload.into(),
                context: DelegateContext::default(),
                processed: false,
            }
        )],
    });

    let bytes = serialize(&request)?;
    connection.send(&bytes)?;

    Ok(())
}
```

## Reactive Components

### Basic Component Pattern

```rust
use dioxus::prelude::*;

#[component]
fn ContractView(contract_key: ContractKey) -> Element {
    // Read from global state (reactive)
    let contracts = CONTRACTS.read();
    let state = contracts.get(&contract_key);

    match state {
        Some(state) => rsx! {
            div { class: "contract-view",
                h2 { "{state.title}" }
                // Render state...
            }
        },
        None => rsx! {
            div { class: "loading", "Loading..." }
        },
    }
}
```

### Form with State Update

```rust
#[component]
fn MessageInput(contract_key: ContractKey) -> Element {
    let mut message = use_signal(String::new);

    let send = move |_| {
        let text = message.read().clone();
        if !text.is_empty() {
            spawn(async move {
                if let Some(api) = WEB_API.read().as_ref() {
                    let delta = create_message_delta(&text);
                    send_update(&api.connection, contract_key, delta).await.ok();
                }
            });
            message.set(String::new());
        }
    };

    rsx! {
        div { class: "message-input",
            input {
                value: "{message}",
                oninput: move |e| message.set(e.value().clone()),
                onkeypress: move |e| if e.key() == Key::Enter { send(()) },
            }
            button { onclick: send, "Send" }
        }
    }
}
```

## Development Features

### Example Data Mode

```rust
#[cfg(feature = "example-data")]
fn initial_state() -> AppState {
    AppState {
        contracts: example_contracts(),
        // Pre-populated test data
    }
}

#[cfg(not(feature = "example-data"))]
fn initial_state() -> AppState {
    AppState::default()
}
```

### No-Sync Mode

```rust
#[cfg(not(feature = "no-sync"))]
async fn start_sync() {
    let connection = FreenetConnection::connect(GATEWAY_WS).await?;
    // Start synchronization...
}

#[cfg(feature = "no-sync")]
async fn start_sync() {
    // Do nothing - offline mode
    log::info!("Running in no-sync mode");
}
```

---

## TypeScript + Vite Approach

For teams more comfortable with TypeScript, Vite provides fast iteration with HMR, SCSS support, and familiar npm tooling. The `@freenetorg/freenet-stdlib` TypeScript package provides the WebSocket API with FlatBuffers serialization.

### Vite Configuration

The key trick: inject contract hashes and delegate key bytes as compile-time constants via Vite `define`. These are computed during `make build` and written to JSON/text files.

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function readFileOrDefault(filename: string, fallback: string): string {
  const filePath = resolve(__dirname, filename);
  return existsSync(filePath) ? readFileSync(filePath, "utf-8").trim() : fallback;
}

export default defineConfig({
  // If using a local freenet-stdlib checkout (common during development):
  resolve: {
    alias: {
      "@freenetorg/freenet-stdlib/client-request": resolve(
        __dirname, "../../freenet-stdlib/typescript/src/client-request.ts"
      ),
      "@freenetorg/freenet-stdlib/common": resolve(
        __dirname, "../../freenet-stdlib/typescript/src/common.ts"
      ),
      "@freenetorg/freenet-stdlib": resolve(
        __dirname, "../../freenet-stdlib/typescript/src/index.ts"
      ),
    },
  },
  define: {
    // Contract key (base58 string) — written by `fdev inspect ... key`
    __MODEL_CONTRACT__: JSON.stringify(
      readFileOrDefault("model_code_hash.txt", "DEV_MODE_NO_CONTRACT_HASH")
    ),
    // Delegate key bytes (pre-decoded from base58 to number[])
    __DELEGATE_KEY_BYTES__: readFileOrDefault("delegate_key_bytes.json", "[]"),
    // Delegate code_hash bytes (BLAKE3 of raw WASM, as number[])
    __DELEGATE_CODE_HASH_BYTES__: readFileOrDefault("delegate_code_hash_bytes.json", "[]"),
  },
  // CRITICAL: relative base path for sandboxed iframe serving
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

**Why `base: "./"` is critical:** Freenet serves webapp files inside a sandboxed iframe at a path like `/v1/contract/web/{CONTRACT_ID}/`. Absolute paths (`/assets/...`) would resolve against the node root and 404. Relative paths (`./assets/...`) resolve correctly within the iframe.

### TypeScript Type Declarations

Declare the compile-time constants so TypeScript doesn't complain:

```typescript
// src/vite-env.d.ts
declare const __MODEL_CONTRACT__: string;
declare const __DELEGATE_KEY_BYTES__: number[];
declare const __DELEGATE_CODE_HASH_BYTES__: number[];
```

### WebSocket Connection (TypeScript)

Use `FreenetWsApi` from the stdlib TypeScript package. It handles FlatBuffers serialization/deserialization automatically.

```typescript
import {
  FreenetWsApi,
  ContractKey,
  GetRequest,
  GetResponse,
  UpdateRequest,
  UpdateResponse,
  UpdateNotification,
  UpdateData,
  UpdateDataType,
  DeltaUpdate,
  SubscribeRequest,
  PutResponse,
  DelegateResponse,
  HostError,
  ResponseHandler,
} from "@freenetorg/freenet-stdlib";

// Build WebSocket URL from current location (works in sandbox iframe)
const wsUrl = new URL(`ws://${location.host}/v1/contract/command`);

const handler: ResponseHandler = {
  onContractPut: (response: PutResponse) => { /* fired on put completion */ },
  onContractGet: (response: GetResponse) => {
    // Decode state bytes → JSON → your app types
    const decoder = new TextDecoder("utf8");
    const json = decoder.decode(Uint8Array.from(response.state));
    const state = JSON.parse(json);
    // Update your UI...
  },
  onContractUpdate: (response: UpdateResponse) => { /* fired on update completion */ },
  onContractUpdateNotification: (notification: UpdateNotification) => {
    // Handle delta updates from subscriptions
    const updateData = notification.update as UpdateData;
    if (updateData?.updateDataType === UpdateDataType.DeltaUpdate) {
      const delta = updateData.updateData as { delta: number[] };
      const json = new TextDecoder().decode(Uint8Array.from(delta.delta));
      // Parse and apply delta...
    }
  },
  // Added in stdlib v0.2.0: fired when a GET targets a missing contract instance
  onContractNotFound: (instanceId) => {
    console.warn("[freenet] Contract not found:", instanceId);
  },
  // Added in stdlib v0.2.0: fired on SUBSCRIBE confirmation (subscribed flag = success)
  onSubscribeResponse: (key, subscribed) => {
    console.log("[freenet] Subscribe:", key.encode(), "ok=", subscribed);
  },
  onDelegateResponse: (response: DelegateResponse) => { /* delegate result */ },
  onErr: (err: HostError) => {
    console.error("[freenet] Error:", err.cause);
  },
  onOpen: () => {
    console.log("[freenet] Connected");
    // Now safe to send GET, SUBSCRIBE, etc.
  },
  // Added in stdlib v0.2.0: WebSocket close. All pending promises will already have rejected.
  onClose: (code, reason) => {
    console.warn("[freenet] Disconnected:", code, reason);
    // App layer decides reconnect strategy — SDK does NOT auto-reconnect.
  },
};

// CRITICAL: Pass empty string as auth token.
// In the sandbox iframe, cookie reading is blocked. The shell page handles auth
// via the postMessage bridge. Passing "" tells FreenetWsApi to skip cookie reading.
const api = new FreenetWsApi(wsUrl, handler, "");
```

### Building ContractKey from Hash

The contract hash (base58 string) from `fdev inspect` needs to be converted to a `ContractKey`:

```typescript
const contractHash = __MODEL_CONTRACT__; // injected by Vite
const keyFromId = ContractKey.fromInstanceId(contractHash);
const instanceBytes = keyFromId.bytes();
// ContractKey needs both instance bytes and code hash bytes.
// When no parameters are used, they're the same.
const contractKey = new ContractKey(instanceBytes, instanceBytes);
```

### Contract Operations

stdlib TS v0.2.0 made `get`, `put`, `update`, `subscribe`, and `disconnect` **promise-based**. They resolve with the typed response, reject on timeout (default 30s), connection close, or host error. The legacy callbacks in `ResponseHandler` still fire for the same response — both APIs coexist for backward compatibility.

```typescript
// GET — fetch current state (await + try/catch)
try {
  const getReq = new GetRequest(contractKey, true);
  const response = await api.get(getReq);
  const json = new TextDecoder().decode(Uint8Array.from(response.state));
  const state = JSON.parse(json);
  // ...use state
} catch (err) {
  console.error("[freenet] GET failed:", err); // timeout / not-found / closed
}

// SUBSCRIBE — receive real-time updates (promise resolves on SubscribeResponse)
try {
  await api.subscribe(new SubscribeRequest(contractKey, []));
} catch (err) {
  console.error("[freenet] SUBSCRIBE failed:", err);
}

// UPDATE — send a delta
const encoder = new TextEncoder();
const deltaBytes = encoder.encode(JSON.stringify(myDelta));
const delta = new DeltaUpdate(Array.from(deltaBytes));
const update = new UpdateData(UpdateDataType.DeltaUpdate, delta);
try {
  await api.update(new UpdateRequest(contractKey, update));
} catch (err) {
  console.error("[freenet] UPDATE failed:", err);
}
```

### Large state handling (streaming)

stdlib TS v0.2.0 ports the Rust streaming protocol. You don't need to call any special API — chunking and reassembly are transparent — but you should know the limits.

**Outbound (request side):**
- Any serialized request larger than `CHUNK_THRESHOLD = 512 KB` is automatically split into sequential `StreamChunk` messages of `CHUNK_SIZE = 256 KB` by `sendRequest()`.
- A 600 KB `PutRequest` goes over the wire as multiple chunks; the receiver reassembles it. Your code just does `await api.put(req)` — no opt-in flag.

**Inbound (response side):**
- The SDK reassembles incoming chunked responses inside `ReassemblyBuffer`. If you ever need raw control (e.g., a custom transport), import the buffer directly:
  ```typescript
  import { ReassemblyBuffer } from "@freenetorg/freenet-stdlib"; // or "@freenetorg/freenet-stdlib/streaming"
  ```
- Limits hard-coded in v0.2.0: per-stream TTL **60 s**, max **8 concurrent streams**, max **256 chunks/stream**. Out-of-order chunks are tolerated; duplicates and overflows are rejected with `StreamError`.

**When this matters:** large media uploads, snapshot-style state initialization, multi-MB contract codes. Below 512 KB the protocol is invisible.

### Delegate Communication (TypeScript)

Sending messages to delegates from TypeScript requires building FlatBuffers objects manually. The public API only exposes high-level types; you need internal `-T` types (the mutable FlatBuffers table classes) that have `pack()` methods.

**Dynamic imports are required** because these internal types aren't part of the main export:

```typescript
import { FreenetWsApi, DelegateRequest } from "@freenetorg/freenet-stdlib";

export async function sendDelegateMessage(
  api: FreenetWsApi,
  delegateKeyBytes: number[],
  delegateCodeHash: number[],
  message: object
): Promise<void> {
  const payload = Array.from(new TextEncoder().encode(JSON.stringify(message)));

  // Import internal FlatBuffers table types (resolved by Vite aliases)
  // @ts-ignore — resolved by Vite alias at build time
  const { ApplicationMessageT } = await import("@freenetorg/freenet-stdlib/common");
  // @ts-ignore — resolved by Vite alias at build time
  const {
    ClientRequestT,
    ClientRequestType,
    ApplicationMessagesT,
    DelegateKeyT,
    DelegateRequestType,
    InboundDelegateMsgT,
    InboundDelegateMsgType,
  } = await import("@freenetorg/freenet-stdlib/client-request");

  // Build the message chain
  const appMsg = new ApplicationMessageT(payload, [], false);
  const inbound = new InboundDelegateMsgT(
    InboundDelegateMsgType.common_ApplicationMessage,
    appMsg
  );

  // DelegateKey has TWO fields: key bytes AND code_hash bytes
  const delegateKey = new DelegateKeyT(delegateKeyBytes, delegateCodeHash);

  const appMessages = new ApplicationMessagesT(delegateKey, [], [inbound]);
  const delegateReq = new DelegateRequest(
    DelegateRequestType.ApplicationMessages,
    appMessages
  );
  const clientReq = new ClientRequestT(
    ClientRequestType.DelegateRequest,
    delegateReq
  );

  // sendRequest is a private method — access via cast
  (api as any).sendRequest(clientReq);
}
```

> **Warning — unstable API:** `(api as any).sendRequest(...)` reaches into a private SDK method because the public delegate-request builder is not yet stable in stdlib v0.2.0. This cast may break on any minor SDK bump. Track [freenet-stdlib](https://github.com/freenet/freenet-stdlib) for a public `api.sendDelegateMessage()` (or equivalent) before relying on this in production.

### Parsing Delegate Responses

```typescript
import { DelegateResponse } from "@freenetorg/freenet-stdlib";

export function parseDelegateResponse(response: DelegateResponse): object[] {
  const results: object[] = [];
  if (!response.values) return results;

  for (const outbound of response.values) {
    // OutboundDelegateMsgType.common_ApplicationMessage = 1
    if (outbound.inboundType !== 1) continue;

    const msg = outbound.inbound as { payload?: number[] } | null;
    if (!msg?.payload?.length) continue;

    try {
      const bytes = new Uint8Array(msg.payload);
      const json = new TextDecoder().decode(bytes);
      results.push(JSON.parse(json));
    } catch (e) {
      console.warn("Failed to parse delegate payload:", e);
    }
  }

  return results;
}
```

### Pre-Decoded Key Bytes Pattern

The browser sandbox can't reliably run base58 decoding libraries. Pre-decode keys at build time and inject as JSON arrays:

```bash
# In your Makefile publish-identity target:
# 1. Publish delegate, capture base58 key
key=$(fdev publish --code ... delegate 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'key: [^ ,]*' | head -1 | cut -d' ' -f2)

# 2. Decode base58 → JSON byte array (requires bs58 npm package)
node -e "const bs58=require('bs58');console.log(JSON.stringify(Array.from(bs58.default.decode('$key'))))" > delegate_key_bytes.json

# 3. Compute code_hash from raw WASM (BLAKE3)
code_hash_hex=$(b3sum --no-names target/wasm32-unknown-unknown/release/my_delegate.wasm)
node -e "const h='$code_hash_hex'.trim();console.log(JSON.stringify(Array.from(Buffer.from(h,'hex'))))" > delegate_code_hash_bytes.json
```

Vite injects these as `__DELEGATE_KEY_BYTES__` and `__DELEGATE_CODE_HASH_BYTES__` compile-time constants.

### Microblogging Reference

See [freenet-microblogging](https://github.com/freenet/freenet-microblogging) for a complete TypeScript + Vite implementation:
- `web/src/freenet-api.ts` — FreenetWsApi wrapper with GET/UPDATE/SUBSCRIBE
- `web/src/delegate-api.ts` — Delegate FlatBuffers message building
- `web/src/identity.ts` — Identity management (delegate + in-memory fallback)
- `web/vite.config.ts` — Build-time key injection
- `Makefile` — Full build pipeline

## River UI Reference

See [River's UI](https://github.com/freenet/river/tree/main/ui) for a complete implementation:
- `src/main.rs` - Entry point
- `src/components/app.rs` - Root component, global state
- `src/components/app/freenet_api/` - WebSocket connection
  - `freenet_synchronizer.rs` - Main synchronization
  - `connection_manager.rs` - Connection lifecycle
  - `room_synchronizer.rs` - Per-contract sync
- `src/components/app/chat_delegate.rs` - Delegate communication
- `src/room_data.rs` - State management
