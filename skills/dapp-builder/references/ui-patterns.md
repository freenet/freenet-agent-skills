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
dioxus = { version = "0.7", features = ["web", "router"] }
dioxus-logger = "0.7"
freenet-stdlib = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
web-sys = { version = "0.3", features = ["WebSocket", "MessageEvent"] }
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
gloo-timers = "0.3"

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

### Connection Manager

```rust
use web_sys::{WebSocket, MessageEvent};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

pub struct FreenetConnection {
    ws: WebSocket,
}

impl FreenetConnection {
    pub async fn connect(gateway_url: &str) -> Result<Self, JsValue> {
        let ws = WebSocket::new(gateway_url)?;
        ws.set_binary_type(web_sys::BinaryType::Arraybuffer);

        // Set up message handler
        let onmessage = Closure::wrap(Box::new(move |event: MessageEvent| {
            if let Ok(buffer) = event.data().dyn_into::<js_sys::ArrayBuffer>() {
                let bytes = js_sys::Uint8Array::new(&buffer).to_vec();
                handle_message(bytes);
            }
        }) as Box<dyn FnMut(MessageEvent)>);

        ws.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
        onmessage.forget();

        Ok(Self { ws })
    }

    pub fn send(&self, message: &[u8]) -> Result<(), JsValue> {
        self.ws.send_with_u8_array(message)
    }
}
```

### Gateway URL

```rust
// Default Freenet gateway WebSocket endpoint
const GATEWAY_WS: &str = "ws://127.0.0.1:7509";
```

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
