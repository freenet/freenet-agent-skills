# UI Patterns

The UI is the interaction layer that connects to the Freenet Kernel via WebSocket/HTTP. River uses Dioxus (Rust), but you can use any web framework.

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
dioxus = { version = "0.7.3", features = ["web"] }
dioxus-free-icons = { version = "0.10.0", features = ["font-awesome-solid"] }
freenet-stdlib = { version = "0.6.0", features = ["net"] }
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
