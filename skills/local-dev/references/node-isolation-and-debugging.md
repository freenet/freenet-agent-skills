# Node isolation and debugging

Read this when a test node misbehaves, when you need a gateway plus a peer on one host, or when
testing from a phone. The basic isolated gateway recipe is in `SKILL.md`.

## Isolation rules

### `--data-dir` does not move `config.toml` or `gateways.toml`

Both live in the config directory. Give every node its own `--config-dir` as well as `--data-dir`;
two nodes that share one also share `config.toml` and the transport keypair, so the second fails to
bind its UDP port or both use the same peer ID. `--config-dir` also wins over `XDG_CONFIG_HOME`, so
the same command works on a laptop and in CI. The directory must already exist (`mkdir -p` it); the
node creates the data and log directories itself.

With `--skip-load-from-network`, a gateway (`--is-gateway`) and a peer given `--gateway` entries
ignore the on-disk `gateways.toml`. A peer with `--skip-load-from-network` and no `--gateway` still
reads it, so put `gateways = []` in that node's own config directory (an empty file fails with
`missing field 'gateways'`).

Check isolation in the log: an isolated gateway logs `No gateways available, aborting join
procedure`; a peer logs `Starting initial join procedure with N gateways`, and N must equal the
number of `--gateway` flags you passed.

### `fdev` defaults to port 7509

`fdev` targets `ws://127.0.0.1:7509` unless `--port` is passed. On a machine running a system
Freenet service (which owns 7509), `fdev publish ...` without `--port` silently goes to that node,
not your test node.

```bash
fdev --port 7510 publish --code ... contract ...
```

A symptom of a misdirected publish is `Signature verification failed: signature error` on a fresh
publish, because the system node holds older state for that key signed by a different key. If you
see it on a "fresh" test, check which node `fdev` actually hit. Tasks that wrap `fdev` (cargo-make,
Make) need `WS_API_PORT=7510` in their environment instead, since `fdev` reads that variable.

## A gateway plus a peer on one host

Start the gateway as in `SKILL.md`, with its own `--config-dir` and `--data-dir`. A peer connects to
it with `--gateway "ip:port,<64-hex X25519 public key>"`. The gateway's public key is not written
anywhere; derive it from `<gateway data dir>/secrets/transport_keypair` (the private key as hex):

```bash
priv=$(cat ~/freenet-test-node/data/secrets/transport_keypair)
{ printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x6e\x04\x22\x04\x20'; echo -n "$priv" | xxd -r -p; } \
  | openssl pkey -inform DER -pubout -outform DER 2>/dev/null | xxd -p -c 64 | tail -1 | sed 's/^.*032100//'
```

```bash
mkdir -p ~/freenet-test-peer/config
freenet network \
  --skip-load-from-network \
  --ws-api-port 7511 \
  --gateway "127.0.0.1:31338,<hex pubkey from above>" \
  --config-dir ~/freenet-test-peer/config \
  --data-dir ~/freenet-test-peer/data \
  --log-dir ~/freenet-test-peer/logs
```

A working multi-node harness (up, down, wipe, status, full state wipe between runs) is
`scripts/run-isolated-nodes.sh` in the freenet/mail repo. A node started from a release binary
checks for a newer release at startup and may exit to auto-update; that harness points
`HTTPS_PROXY` at a dead local port so a long-running test node stays up.

## Phone on the same WiFi

Bind the API to all interfaces, then open the contract from the phone:

```bash
freenet network ... --ws-api-address 0.0.0.0 --ws-api-port 7510
# http://{YOUR_LAN_IP}:7510/v1/contract/web/{CONTRACT_ID}/
```

Anything that can reach that port can read your contract state and keys, so use a trusted network.
Find the LAN IP with `ifconfig en0 | grep "inet "` (macOS) or `ip addr show wlan0` (Linux).

A mobile browser suspends WebSocket connections when the screen locks, the tab goes to the
background, or heavy WASM work starves the event loop. Reconnect on `visibilitychange`. After
republishing, a phone may keep showing the old WASM; clear the browser cache or force-close the
browser.

## Reading logs

Logs are `<log-dir>/freenet.YYYY-MM-DD-HH.log`; the glob `freenet.*.log` also matches the WARN-only
`freenet.error.*.log`. Release builds log at INFO and above whatever `--log-level` says.

```bash
tail -f <log-dir>/freenet.$(date +%Y-%m-%d-%H).log
grep -i "delegate\|contract\|websocket\|error" <log-dir>/freenet.*.log | tail -50
grep "<transaction id>" <log-dir>/freenet.*.log     # follow one operation
```

To reproduce a UI flow without clicking, drive the contract URL with the Playwright MCP tools
(navigate, snapshot, click or fill, read console messages) and check the console for WASM panics.
A flow that works there but not on a phone usually points at WebSocket suspension or caching.

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Gateway nodes must specify a public network address/port" | Missing `--public-network-address` or `--public-network-port` | Pass both |
| "Configuration directory not found" | `--config-dir` does not exist | `mkdir -p` it |
| Signing key lost after node restart | Used `--id` (ephemeral temp dir) | Use `--data-dir` |
| "Auth token not found" in the node log | Stale page after a node restart | Reload the page |
| "delegate not found in store" | Migration probe for a delegate this node never held | Expected, non-blocking |
| "Connection reset by peer" | Browser killed the WebSocket | Check for a background tab |
| Contract not found | Not published to this node | Publish with `fdev --port {PORT}` |
| "Signature verification failed" on a fresh publish | `fdev` hit the system node on 7509 | Pass `fdev --port {TEST_PORT}` |
| Test node joins the public network | Peer has no `--gateway` and reads the on-disk `gateways.toml` | See "Isolation rules" |
| Blank page after republish | Browser cached old WASM | Clear cache or force-close the browser |
| A delegate's contract GET/PUT/UPDATE/SUBSCRIBE does nothing, lifecycle events or wake-ups never arrive | Node started with `freenet local` | Use `freenet network` (see `SKILL.md`) |
