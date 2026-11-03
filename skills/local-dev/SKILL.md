---
name: local-dev
description: Set up and manage local Freenet development environments and interact with a running node. Use when the user wants to test contract changes locally, debug UI issues, run a local node, query connections/diagnostics, inspect the dashboard, use the WebSocket API, or iterate on a Freenet application without deploying to the live network.
license: LGPL-3.0
---

# Freenet Local Development & Node Interaction

Guidance for running local Freenet nodes, publishing contracts, querying node state, and debugging dApps during development.

## Prerequisites

```bash
which freenet fdev
rustup target add wasm32-unknown-unknown
```

## Architecture

### Ports & Services

| Service | Default Port | Flag | Purpose |
|---------|-------------|------|---------|
| Network (P2P, UDP) | a free port chosen at first start | `--network-port` | Peer-to-peer connections |
| WebSocket API | 7509 | `--ws-api-port` | Client API (UI, CLI tools, fdev) |

### HTTP Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Home dashboard |
| `GET /peer/{address}` | Peer detail page |
| `GET /v1/contract/web/{key}` | Contract web interface |
| `WS /v1/contract/command?encodingProtocol=native` | WebSocket API |

The dashboard at `http://localhost:7509/` shows connection status, peers, hosted and subscribed contracts, and operation counts. For the same data in a script, use `fdev query` and `fdev diagnostics` rather than scraping the HTML.

### Node Data Locations

| Platform | Data directory | Config directory (`config.toml`, `gateways.toml`) |
|----------|----------------|-----------------|
| macOS | `~/Library/Application Support/The-Freenet-Project-Inc.Freenet/` | same as data |
| Linux | `~/.local/share/freenet/` | `~/.config/freenet/` |

The data directory holds `contracts/`, `delegates/`, `secrets/` and `db/`. Logs are written to `--log-dir` as `freenet.YYYY-MM-DD-HH.log` (WARN and above also go to `freenet.error.*.log`).

## Running Local Nodes

### Single node (simplest)

Your existing node on port 7509 works. Publish test contracts to it directly.

### Isolated test node (won't affect your running node)

```bash
mkdir -p ~/freenet-test-node/config      # --config-dir must already exist
freenet network \
  --is-gateway --skip-load-from-network \
  --network-port 31338 \
  --public-network-address 127.0.0.1 --public-network-port 31338 \
  --ws-api-port 7510 \
  --config-dir ~/freenet-test-node/config \
  --data-dir ~/freenet-test-node/data \
  --log-dir ~/freenet-test-node/logs
```

A gateway needs both `--public-network-address` and `--public-network-port`; without them it exits at startup. The API binds to loopback by default. Only add `--ws-api-address 0.0.0.0` for phone testing on a network you trust.

Give every test node its own `--config-dir` and `--data-dir`. `fdev` defaults to port 7509 and will silently target whichever node owns that port, often your system service, so pass `fdev --port 7510 ...` for a test node. Details, a gateway plus peer on one host, and phone testing: `references/node-isolation-and-debugging.md`.

**WARNING:** Do NOT use `--id` for local dev. It creates ephemeral temp directories that get wiped on restart, destroying delegate secrets (signing keys, app data). A debug build does the same without `--id` when you pass no config or data dir: it uses and wipes a temp dir. Use `--data-dir` for persistent isolation instead.

### Delegates need network mode

`freenet local` does not service a delegate's contract requests (GET, PUT, UPDATE, SUBSCRIBE), `RequestUserInput`, lifecycle events or wake-ups, and nothing reports an error. Only the delegate's reads through `DelegateCtx::get_contract_state` work. Start any node that runs a delegate with `freenet network`. Detail and source references: `dapp-builder` skill, `references/delegate-patterns.md`, "`freenet local` Does Not Run the Delegate Contract Loop".

## Publishing Contracts Locally

### Using fdev

**IMPORTANT:** fdev argument order matters. `--code` and `--parameters` go before the `contract` subcommand. `--port` goes before `execute`.

```bash
# Publish a contract with webapp
fdev --port 7510 execute put \
  --code target/wasm32-unknown-unknown/release/my_contract.wasm \
  --parameters params.bin \
  contract \
  --webapp-archive target/webapp/webapp.tar.xz \
  --webapp-metadata target/webapp/webapp.metadata

# Get contract ID without publishing
fdev get-contract-id \
  --code target/wasm32-unknown-unknown/release/my_contract.wasm \
  --parameters params.bin
```

`fdev` also reads `WS_API_PORT`, so `WS_API_PORT=7510 fdev ...` targets the test node. Do not export it in the shell that starts the node, because the node reads the same variable for its own port.

### Querying Node State

```bash
fdev query                                      # connected peers and subscriptions
fdev diagnostics                                # full node diagnostics
fdev diagnostics --contract <base58_contract_id>
```

## WebSocket API

```
ws://127.0.0.1:7509/v1/contract/command?encodingProtocol=native
```

- **Encoding:** `native` (bincode) or `flatbuffers` (the default when the parameter is omitted).
- **Auth:** the node issues a token when it serves a contract's shell page, in memory, so it is invalid after a node restart (the node closes the WebSocket with code 4401). A webapp inside that page gets it from the shell. A standalone client may connect with no token, as `fdev` does.

Request and response types are in `freenet_stdlib::client_api` (`ClientRequest`, `NodeQuery`, `NodeDiagnosticsConfig`).

## Config File

`config.toml` (in the config directory) uses the long CLI flag names without the dashes, for example `ws-api-port`, `network-port`, `min-number-of-connections`. `freenet network --help` lists them with defaults.

## Debugging

Release builds log at INFO and above whatever `--log-level` says; debug output needs a binary built from source. Give each node its own `--log-dir` so logs do not interleave. Log patterns, Playwright and phone debugging, and a table of common errors: `references/node-isolation-and-debugging.md`.

## Simulation testing

```bash
# Single-process test network (no real networking)
fdev test --gateways 2 --nodes 10 --events 100 --seed 0xDEADBEEF single-process

# With fault injection
fdev test --message-loss 0.1 --latency-min 50 --latency-max 200 single-process
```

Flags go before `single-process`.
