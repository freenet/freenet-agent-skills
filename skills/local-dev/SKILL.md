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

Persistent data lives in `--data-dir` and logs in `--log-dir`, but the
**gateway bootstrap list is NOT isolated** by `--data-dir` — see
[Isolation pitfalls](#isolation-pitfalls) below before assuming the node
is offline-only. Likewise, `fdev` defaults to port 7509 and will silently
target whichever node owns that port (often the system service, not your
test node).

**WARNING:** Do NOT use `--id` for local dev. It creates ephemeral temp directories
that get wiped on restart, destroying delegate secrets (signing keys, app data).
Use `--data-dir` for persistent isolation instead.

### Isolation pitfalls

#### `--data-dir` does NOT isolate the gateway bootstrap list

`freenet` reads `gateways.toml` from the global config directory regardless
of `--data-dir`:

- **macOS:** `~/Library/Application Support/The-Freenet-Project-Inc.Freenet/gateways.toml`
- **Linux:** `~/.config/freenet/gateways.toml`

On a machine with an existing Freenet install, a "local" test node will
dial real public gateways (e.g. `nova.locut.us`, `vega.locut.us`) and
attempt NAT traversal to live peers — silently joining the public network.

To fully isolate, override `HOME` so the node sees an empty gateway list:

```bash
# macOS
mkdir -p ~/iso-home/Library/Application\ Support/The-Freenet-Project-Inc.Freenet
printf 'gateways = []\n' > ~/iso-home/Library/Application\ Support/The-Freenet-Project-Inc.Freenet/gateways.toml

# Linux
mkdir -p ~/iso-home/.config/freenet
printf 'gateways = []\n' > ~/iso-home/.config/freenet/gateways.toml

# Then launch with HOME overridden. For an isolated *gateway* node
# (--is-gateway, no --gateway flags), expect 0 bootstrap gateways:
HOME=~/iso-home freenet network --is-gateway --skip-load-from-network ...

# For an isolated *peer* node, pass your local gateway(s) explicitly:
HOME=~/iso-home freenet network --gateway "127.0.0.1:31337,$GATEWAY_PUBKEY" ...
```

Note: an empty `gateways.toml` will fail with `missing field 'gateways'`.
The file must contain `gateways = []`.

**Verification:** grep the node log for the initial-join line and confirm
the gateway count matches what you passed:

```bash
grep "Starting initial join procedure" "$LOG_DIR"/freenet.*.log
# Expect: "...with N gateways" where N == number of --gateway flags
# For an isolated gateway node (no --gateway flags), N must be 0.
# If N is higher than expected, isolation is broken.
```

Upstream tracking: [freenet/freenet-core#3980](https://github.com/freenet/freenet-core/issues/3980).

#### `fdev` defaults to port 7509

`fdev` targets `ws://127.0.0.1:7509` unless `--port` is passed. On a dev
machine running a system Freenet service (which owns 7509), `fdev publish ...`
without `--port` silently goes to that node, not your isolated test node.

```bash
# WRONG: silently targets whichever node owns 7509 (often the system service)
fdev publish --code ... contract ...

# RIGHT: always pass --port when targeting a non-default test node
fdev --port 7510 publish --code ... contract ...
```

Symptom of a misdirected publish: `"Signature verification failed: signature error"`
on a fresh publish to the test node, because the system node has stale
contract state from a previous run signed by a different key. If you see
this on a "fresh" test, check which node `fdev` actually hit.

#### `--data-dir` does NOT isolate `config.toml` either — use `--config-dir` per node

Two `freenet` processes on the same host that pass the same (or default)
config directory share `config.toml` AND `secrets/transport-keypair.pem`.
Symptoms: second node fails to bind its UDP port, or both nodes use
identical peer IDs and the network refuses the duplicate connection.

For a deterministic multi-node harness on one host (gateway + peer + …),
pass `--config-dir` explicitly to each node, NOT just `--data-dir`:

```bash
freenet network --config-dir /tmp/iso-net/gw/config   --data-dir /tmp/iso-net/gw/data   ...
freenet network --config-dir /tmp/iso-net/peer/config --data-dir /tmp/iso-net/peer/data ...
```

**CI gotcha:** on Linux runners that set `XDG_CONFIG_HOME` (e.g. ubicloud,
sometimes GitHub Actions images), `dirs::config_dir()` returns
`$XDG_CONFIG_HOME` regardless of `HOME` — so the `HOME=~/iso-home …`
trick from the previous section is bypassed. `--config-dir` is the only
flag that wins against `XDG_CONFIG_HOME`. Use it any time the harness
must run identically on dev laptops and CI.

A working reference harness lives at
`scripts/run-isolated-nodes.sh` in the freenet/mail repo — covers up /
down / wipe / status, full state wipe between test runs (avoids day-1
AFT cap carryover in repeated E2E runs), and `FREENET_E2E_KEEP=1` to
leave nodes up for post-mortem.

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
| Contract not found | Not published to this node | Publish with `fdev --port {PORT}` (see [Isolation pitfalls](#isolation-pitfalls)) |
| "Signature verification failed" on a fresh publish | `fdev` defaulted to port 7509 and hit the system node | Pass `fdev --port {TEST_PORT}` explicitly |
| Test node joins public network despite `--data-dir` | `gateways.toml` is read from global config, not `--data-dir` | Override `HOME` to a sandbox dir with `gateways = []` (see [Isolation pitfalls](#isolation-pitfalls)) |
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
