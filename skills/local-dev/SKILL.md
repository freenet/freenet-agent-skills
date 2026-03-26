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
| Network (P2P) | 31337 | `--network-port` | Peer-to-peer connections |
| WebSocket API | 7509 | `--ws-api-port` | Client API (UI, CLI tools, fdev) |

### HTTP Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Home dashboard (auto-refreshes every 5s) |
| `GET /peer/{address}` | Peer detail page |
| `GET /v1/contract/web/{key}` | Contract web interface |
| `WS /v1/contract/command?encodingProtocol=native` | WebSocket API v1 |
| `WS /v2/contract/command?encodingProtocol=native` | WebSocket API v2 |

### Dashboard

The home dashboard at `http://localhost:7509/` shows:
- Connection status, peer count, own ring location
- Peer table: address, ring location, type (Peer/Gateway), bytes sent/received, connected duration
- External address (NAT traversal result), NAT statistics
- Contract counts (hosted, subscribed, managed)
- Operation stats (GET/PUT/UPDATE/SUBSCRIBE success/failure counts)

Scraping peer data:
```bash
# Get own location
curl -s http://localhost:7509/ | grep -o 'own-loc[^<]*<[^>]*>[^<]*'

# Get peer rows (address, location, type, sent, recv, uptime)
curl -s http://localhost:7509/ | grep -o 'peer-row[^}]*'
```

### Node Data Locations

| Platform | Default Data Path |
|----------|-------------------|
| macOS | `~/Library/Application Support/The-Freenet-Project-Inc.Freenet/` |
| Linux | `~/.local/share/freenet/` |

Contents: `contracts/` (WASM), `delegates/`, `secrets/`, `db/`, `config.toml`

### Log Directory Convention

Choose an appropriate log directory for your OS:
- **macOS**: `~/Library/Logs/freenet-test-node`
- **Linux**: `~/.local/share/freenet-test-node/logs`

The examples below use `$LOG_DIR` as a placeholder. Set it once:
```bash
# macOS:
LOG_DIR=~/Library/Logs/freenet-test-node
# Linux:
LOG_DIR=~/.local/share/freenet-test-node/logs

mkdir -p "$LOG_DIR"
```

## Running Local Nodes

### Single node (simplest)

Your existing node on port 7509 works. Publish test contracts to it directly.

### Isolated test node (won't affect your running node)

**IMPORTANT:** Gateway nodes require `--public-network-address`. Always use
`--log-dir` to isolate logs from your main node.

```bash
freenet network \
  --network-port 31338 \
  --ws-api-port 7510 \
  --ws-api-address 0.0.0.0 \
  --is-gateway \
  --skip-load-from-network \
  --data-dir ~/freenet-test-node/data \
  --public-network-address 127.0.0.1 \
  --log-dir "$LOG_DIR" \
  --log-level debug
```

Each node is fully isolated: persistent data in `--data-dir`, logs in `--log-dir`.

**WARNING:** Do NOT use `--id` for local dev. It creates ephemeral temp directories
that get wiped on restart, destroying delegate secrets (signing keys, app data).
Use `--data-dir` for persistent isolation instead.

### Two-node local network

```bash
# Terminal 1: Gateway
freenet network \
  --network-port 31337 \
  --ws-api-port 7509 \
  --is-gateway \
  --skip-load-from-network \
  --data-dir ~/freenet-local-gw/data \
  --public-network-address 127.0.0.1 \
  --log-dir ~/freenet-local-gw/logs \
  --log-level debug

# Terminal 2: Peer (get gateway pubkey first)
GATEWAY_KEY=$(cat ~/.config/Freenet/secrets/local-gw/transport.pub 2>/dev/null || echo "CHECK_PUBKEY")
freenet network \
  --network-port 31338 \
  --ws-api-port 7510 \
  --gateway "127.0.0.1:31337,${GATEWAY_KEY}" \
  --skip-load-from-network \
  --data-dir ~/freenet-local-peer/data \
  --log-dir ~/freenet-local-peer/logs \
  --log-level debug
```

### Mobile testing (phone on same WiFi)

```bash
# Bind WebSocket API to all interfaces (--ws-api-address 0.0.0.0)
freenet network \
  --ws-api-address 0.0.0.0 \
  --ws-api-port 7510 \
  --network-port 31338 \
  --is-gateway \
  --skip-load-from-network \
  --data-dir ~/freenet-mobile-test/data \
  --public-network-address 127.0.0.1 \
  --log-dir ~/freenet-mobile-test/logs \
  --log-level debug

# Phone opens: http://{YOUR_LAN_IP}:7510/v1/contract/web/{CONTRACT_ID}/
# Find LAN IP:
#   macOS:  ifconfig en0 | grep "inet "
#   Linux:  ip addr show wlan0
```

### Multi-instance deployment (10 peers + gateway)

```bash
# Uses deploy-local-gateway.sh from freenet-core
cd /path/to/freenet-core
scripts/deploy-local-gateway.sh --all-instances
```

## Publishing Contracts Locally

### Using fdev

**IMPORTANT:** fdev argument order matters. `--code` and `--parameters` go
before the `contract` subcommand. `--port` goes before `execute`.

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

### Targeting a specific node

Override the WebSocket port for fdev:
```bash
fdev --port 7510 execute put --code ... contract ...
```

### Querying Node State

```bash
# List connected peers and subscriptions
fdev query

# Get detailed node diagnostics
fdev diagnostics

# Get diagnostics for specific contracts
fdev diagnostics --contract <base58_contract_id>
```

## WebSocket API

### Connection

```
ws://127.0.0.1:7509/v1/contract/command?encodingProtocol=native
```

- **Encoding:** `native` (bincode) or `flatbuffers`
- **Auth:** Send `ClientRequest::Authenticate { token }` after connecting
- **Tokens:** Generated per-connection, base58-encoded 32 bytes. Invalidated on node restart (error prefix: `AUTH_TOKEN_INVALID`).

### Request Types

```rust
pub enum ClientRequest {
    ContractOp(ContractRequest),   // GET, PUT, UPDATE, Subscribe
    DelegateOp(DelegateRequest),   // Delegate operations
    Authenticate { token },         // Auth token
    NodeQueries(NodeQuery),         // Queries (see below)
    Disconnect { cause },           // Close with reason
    Close,                          // Graceful close
}
```

### NodeQuery Variants

| Query | Response | Data |
|-------|----------|------|
| `ConnectedPeers` | `ConnectedPeers { peers }` | `Vec<(peer_id, socket_addr)>` |
| `SubscriptionInfo` | `NetworkDebug(info)` | Subscriptions + connected peers |
| `NodeDiagnostics { config }` | `NodeDiagnostics(response)` | Configurable (see below) |
| `ProximityCacheInfo` | `ProximityCache(info)` | Proximity cache state for update propagation |

### NodeDiagnostics Config

```rust
NodeDiagnosticsConfig {
    include_node_info: bool,           // Peer ID, location, uptime
    include_network_info: bool,        // Active connections, peer list
    include_subscriptions: bool,       // Active subscriptions
    contract_keys: Vec<ContractKey>,   // Specific contracts (empty = all)
    include_system_metrics: bool,      // Connection count, seeding contracts
    include_detailed_peer_info: bool,  // Full peer details
    include_subscriber_peer_ids: bool, // Peer IDs of subscribers per contract
}
```

## Config File Reference

```toml
mode = "network"                      # "network" or "local"
network-address = "0.0.0.0"
network-port = 54761                  # UDP port for peer traffic
ws-api-address = "0.0.0.0"
ws-api-port = 7509                    # HTTP + WebSocket port
min-number-of-connections = 25
max-number-of-connections = 100
transient-budget = 2048               # Max concurrent transient connections (gateway)
transient-ttl-secs = 30              # TTL for unpromoted transient connections
token-ttl-seconds = 86400            # Auth token lifetime
token-cleanup-interval-seconds = 300
log_level = "info"
is_gateway = false
```

## Ring Distance

Each peer has a ring location in [0.0, 1.0). Distance between two locations:

```
distance = min(|a - b|, 1.0 - |a - b|)
```

Max distance is 0.5. Use the dashboard peer table to get locations and compute distances.

## Debugging

### Check node status

```bash
# Node status page
curl -s http://127.0.0.1:7510/

# Active WebSocket connections
lsof -i :7510 -P | grep ESTABLISHED     # macOS
ss -tnp | grep 7510                      # Linux
```

### Check node logs

```bash
# Follow logs (use your --log-dir path)
tail -f "$LOG_DIR"/freenet.$(date +%Y-%m-%d-%H).log

# Filter for contract/delegate events
tail -f "$LOG_DIR"/freenet.*.log | grep -i "delegate\|contract\|websocket\|error\|sign"
```

Each node instance should use `--log-dir` pointing to a unique directory
so logs don't interleave.

### Debugging node logs

Key patterns to search for:

```bash
# Follow all delegate + contract activity
grep -i "delegate\|sign\|update\|put\|subscribe" "$LOG_DIR"/freenet.*.log | tail -50

# Track a specific operation by transaction ID
grep "01KK70QEAR" "$LOG_DIR"/freenet.*.log

# WebSocket lifecycle
grep -i "websocket\|connection\|disconnect\|client" "$LOG_DIR"/freenet.*.log | tail -20
```

### Debugging with Playwright (automated browser testing)

Use the Playwright MCP tools to test the full UI flow without manual interaction:

```
1. browser_navigate → open the contract URL
2. browser_snapshot → see the DOM state
3. browser_click / browser_fill_form → interact with the UI
4. browser_console_messages → check for WASM panics or JS errors
```

Especially useful for reproducing mobile issues on desktop, where console
output is visible. If a flow works in Playwright but not on mobile, the
issue is likely WebSocket suspension or browser caching.

### Mobile-specific debugging

**Browser caching:** Mobile browsers aggressively cache WASM bundles. After
republishing, use a cache-busting URL parameter:
```
http://{IP}:7510/v1/contract/web/{CONTRACT_ID}/?_v={timestamp}
```

Or clear browser cache / force close and reopen. Firefox mobile is
particularly aggressive about caching.

**WebSocket suspension:** Mobile browsers suspend WebSocket connections when:
- Screen locks
- Tab goes to background
- Browser switches to another app
- Heavy WASM computation starves the event loop

Your app should handle reconnection when the tab becomes visible again.
Consider implementing a `visibilitychange` listener that re-establishes
the WebSocket connection.

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Gateway nodes must specify a public network address" | Missing `--public-network-address` | Add `--public-network-address 127.0.0.1` |
| Signing key lost after node restart | Used `--id` (ephemeral temp dir) | Use `--data-dir` for persistent data |
| "Auth token not found" | Stale cached page | Hard refresh or clear browser cache |
| "delegate not found in store" | Legacy delegate migration | Expected on fresh node, non-blocking |
| "Connection reset by peer" | Browser killed WebSocket | Check if page is in background tab |
| "peer connection dropped" on put | Publishing to live node failed | Use isolated test node (`--skip-load-from-network`) |
| Contract not found | Not published to this node | Publish with `fdev --port {PORT}` |
| Blank page (cached old WASM) | Mobile browser caches aggressively | Clear cache, force close browser, or use `?_v=timestamp` |
| `sed -i` fails on macOS | BSD sed requires backup extension | Use build tools directly instead of sed |
| `cargo make` targets Linux | Cross-compilation for web-container-tool | Build natively: `cargo build --release -p web-container-tool` |

## Other Infrastructure

### Docker containers (freenet-core)

```bash
# Gateway container
cd /path/to/freenet-core/docker/freenet-gateway
docker-compose up

# Node container
cd /path/to/freenet-core/docker/freenet-node
docker-compose up
```

### fdev simulation testing

```bash
# Single-process test network (no real networking)
fdev test --gateways 2 --nodes 10 --events 100 --seed 0xDEADBEEF single-process

# With fault injection
fdev test --message-loss 0.1 --latency-min 50 --latency-max 200 single-process
```

## Related Skills

- **dapp-builder**: Design and architect new Freenet dApps
- **telemetry-monitor**: Analyze network telemetry from the central collector
- **release**: Publish production releases
