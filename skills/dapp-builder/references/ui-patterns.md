# UI Patterns

The UI is the interaction layer that connects to the Freenet Kernel via WebSocket/HTTP. River uses Dioxus (Rust), but you can use any web framework. This document covers both Dioxus and TypeScript + Vite approaches.

## Architecture Overview

The UI runs in the browser (compiled to WASM for Dioxus, JavaScript for the TypeScript option) and talks to the local Freenet node over a WebSocket; contracts and delegates run in the node. A published webapp is served by the node's gateway inside a sandboxed iframe.

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

### Large Binary Assets: Their Own Contract, Not the Webapp Bundle

Large or unbounded binary assets (audio, video, images, datasets, user uploads) don't belong in the webapp contract's state; see `state-authorization-patterns.md` → "State Size Budget".

The fix isn't to fetch the asset from an external server — the CSP above
blocks that (`connect-src`/`default-src <iframe-origin>` only). It's to give
the asset **its own contract instance** and reference it by key from your
UI. Any contract's non-HTML files are servable at
`/v1/contract/web/{CONTRACT_KEY}/{path}`, and that path is same-origin
with your own UI's iframe regardless of whose key it names — the CSP is
scoped to the gateway's origin, not to a specific contract. So this works
even though it names a different contract than the one serving the page:

```html
<audio src="/v1/contract/web/{ASSET_CONTRACT_KEY}/track.mp3"></audio>
```

A contract used purely as an asset store doesn't need an `index.html`; it can just be a bundle of static files addressed by key.

## Author Contact and Source

Show every user a way to reach the author and find the source, in a footer or About page, from
the first release. Many people only ever see that version. Without it nobody can report a bug
or audit what the app does with their data. Any one of these is enough:

- **Source repository:** if open source, the exact repo the published WASM was built from.
- **Email:** a pseudonymous address is fine.
- **River member ID,** with the full verifying key from River's member info panel. The short ID
  is truncated and not unique, so give the full key.

A pseudonymous channel counts: the aim is a channel to the author, not their identity.

Make each web link a plain `<a href>`, which the gateway opens in a new tab. Do not navigate by
assigning `window.location`: the shell's `frame-src 'self'` refuses it and the click silently
does nothing.

## Dioxus

River's `ui/Cargo.toml` and `ui/Dioxus.toml` are the template; copy them rather than writing your own. Two things are not obvious. `dx` must equal the `dioxus` crate version in `Cargo.lock`. And a webapp served under `/v1/contract/web/<key>/` needs `base_path` set at build time so asset URLs resolve inside the iframe (River keeps the line commented in `Dioxus.toml` and uncomments it during the build; the Vite equivalent is `base: "./"`). Keep the `WebApi` handle in a `GlobalSignal` so any component can send requests.

River's `ui/Cargo.toml` also defines `example-data` and `no-sync` features, which pre-populate test data and disable network synchronization for UI-only work.

## WebSocket Connection

### Two Connection Models: Pick the Right One

A Freenet client can reach the local node over WebSocket in two different ways.
The correct choice depends on **how the client loads**, not on what it wants to do.

| Client load path | Connection model | What to do |
|------------------|------------------|-----------|
| Loaded as a **webapp via `/v1/contract/web/{key}/`** (runs inside the gateway's sandboxed iframe) | **Shell-managed WebSocket** (explained below). | Derive the URL from `window.location` (see below). **Do NOT call `Authenticate`; the shell injects it.** Use `freenet-stdlib::WebApi::start()`. |
| Loaded **outside the gateway** (native CLI, Playwright page served from a dev port like `python3 -m http.server`, a Node script, or any page that did not come from `/v1/contract/web/...`) | **Raw WebSocket.** There is no shell; you talk directly to the node's WS API. | **For a browser page, prefer removing this case** — see "Dev servers: proxy instead of hardcoding" below — so the URL derivation still applies. For a CLI or script, configure the address (flag or env var); hardcode only as the default behind that override. The node accepts a connection with no token, as `fdev` does. See the `local-dev` skill for details. |

In short: **inside an iframe served by `/v1/contract/web/...` the shell manages the socket and the token, so do not authenticate yourself.** Everywhere else, connect directly. A stale token (after a node restart) makes the node close the socket with code 4401; reload the page.

See also `production-smoke-testing.md` for the shell HTML structure and the
Playwright idioms (`frameLocator` / absolute-URL `goto`) needed to reach
into the iframe from E2E tests.

### How the shell-managed WebSocket works

The gateway serves a webapp inside a sandboxed iframe for origin isolation (the shell and its test idioms are in `production-smoke-testing.md`). The shell page (outer frame) holds the auth token and the real WebSocket. Inside the iframe, `window.WebSocket` is replaced by a postMessage shim, so your code calls `WebSocket::new(url)` or `WebApi::start()` as usual and the shell makes the real connection and injects the token. The URL path must be `/v1/contract/command?encodingProtocol=native`, derived from `window.location` so it works on any host and port.

### WebSocket URL (IMPORTANT)

**NEVER hardcode `ws://127.0.0.1:7509`.** Derive the URL from the page location:

A port sniff is not a derivation. `location.port === "7509" ? location.host :
"127.0.0.1:7509"` looks like it handles both rows of the table above, but it
breaks the moment the node serves the app on any other port — which is the
exact case "works on any host/port" is there to protect. Derive
unconditionally; handle the dev case in the dev server, not in app code.

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

### Dev servers: proxy instead of hardcoding

Under `vite dev` (or any dev server) the page is served from the dev port, so
same-origin does not reach the node — which is what tempts a hardcoded address
into app code. Proxy `/v1` in the dev server instead, and the page becomes
same-origin in development too:

```ts
// vite.config.ts
server: {
  proxy: {
    "/v1": {
      target: process.env.FREENET_NODE ?? "http://127.0.0.1:7509",
      ws: true,            // /v1/contract/command is a WebSocket upgrade
      changeOrigin: true,  // see below
    },
  },
},
```

`changeOrigin: true` is not cosmetic: the node's `--allowed-host` is a
**Host-header** allowlist (`is_allowed_host`, `crates/core/src/client_events/websocket.rs`),
and without it the upgrade arrives claiming the dev port, which is not in that
allowlist. On plain loopback you get away with it, because the node's upgrade
guard short-circuits on a localhost `Origin` before it ever consults the Host
allowlist. Set it anyway — the moment the dev server is reached by hostname or
LAN address (`vite --host`, a phone on the same wifi) the `Origin` is no longer
localhost, the Host check runs, and the same request is rejected with 403 and
"possible DNS rebinding attack" in the node's log.

Two things this buys: the node's address lives in one place that an env var can
override (a node on another host or port needs no code change), and app code
has exactly one code path, so the dev path and the shipped path are the same
code.

What it does **not** change is auth. A proxy is transport only: no shell
appears, so a page served from a dev port is still the "outside the gateway"
row of the table above. A raw client may connect with no token, in every mode,
and an invalid token closes the socket with code 4401.

Verify the proxy rather than assuming — a dev server that does not proxy
returns its own 404/index for `/v1/...`, which surfaces as a hang, not an
error:

```sh
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     http://127.0.0.1:5173/v1/contract/command | head -1
# HTTP/1.1 101 Switching Protocols   <- proxied to the node
```

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
freenet-stdlib = { version = "<ver>", features = ["net"] }
# Required for wasm32-unknown-unknown: use JS crypto.getRandomValues for RNG
getrandom = { version = "0.2", features = ["js", "wasm-bindgen", "js-sys"], default-features = false }
```

**Two `freenet-stdlib` versions cannot co-link.** `__frnt_set_id` is `#[no_mangle]`
in every version, so a dependency graph that pulls in both 0.6 and 0.8 fails at link
time with a duplicate-symbol error — cargo's usual "two semver-major versions side by
side" escape hatch does not apply. The unit at risk is one **compiled artifact**, not
the workspace: a contract crate that pulls an older stdlib through a helper library
while depending on the current one directly will not link. Check transitive deps, not
just your own `Cargo.toml`. Where versions differ across *separate* artifacts — your
UI, your CLI, the gateway you publish to — they link fine and fail at runtime instead;
mismatched stdlib is the #1 cause of "variant index out of range" bincode errors, so
pin one version everywhere anyway.

Without the `getrandom` js feature, `getrandom 0.2` emits a `compile_error!` on
`wasm32-unknown-unknown`. River uses this exact pattern.

## Reading Contracts Efficiently

A GET is a search of the network, not a database lookup, and two read patterns make an app slow even when every contract it reads is small: GETting keys nobody has written, and GETting independent keys one at a time.

### A GET for a key nobody has PUT is the slowest read there is

The node cannot tell "this contract does not exist" from "I have not reached a peer that has it yet", so a GET for a never-created key runs its whole search, retries included, before it answers `NotFound`. That is seconds per key, and sometimes longer than the request timeout (30 s in the TS client), so the caller gets a timeout instead of `NotFound`. A GET for a contract that exists stops at the first peer holding it, which is much faster. So a missing key is often the most expensive read your app makes.

So don't make readers find out what exists by GETting it. This matters most
for derived keys: per-period or per-category shards, per-user inboxes, "the
next version" of something.

- **Keep a manifest.** When a writer creates a shard, have it also record the
  shard in a contract readers already fetch, such as the app's root or index
  contract. Readers GET only the shards listed there. That writer must be
  allowed to UPDATE the manifest, and entries need a commutative merge. If
  anyone can add entries, anyone can list never-PUT keys and push every reader
  into slow `NotFound`s.
- **Keep optional reads off the critical path.** Render what is known to
  exist first, then look for older or optional data in the background.
- **If you must probe, treat a `NotFound` as a hint, not a fact.** A
  `NotFound` doesn't prove the contract is absent, so it can't be a durable
  "nothing there". Cache it only with a short expiry, and never let it hide a
  shard the manifest lists. A published webapp has no browser storage (the
  sandboxed iframe has an opaque origin, so `localStorage` throws; see
  `upgrade-and-migration.md`), so a cache that has to survive a reload belongs
  in a delegate.

The legacy-key backward probe in `upgrade-and-migration.md` is the same kind
of read. Read the marker rules there before caching its outcome.

### Don't serialize independent reads

Sending every GET through one promise chain, or awaiting each one in a loop,
makes load time the *sum* of every read's latency, and one slow or missing key
blocks everything behind it. Send independent GETs together and render each
result as it arrives:

```ts
// Slow: total = sum of latencies, and one missing key stalls the rest
for (const key of keys) render(await api.get(new GetRequest(key)));

// Better: total ≈ the slowest read, and each section appears when ready
await Promise.allSettled(
  keys.map((key) => api.get(new GetRequest(key)).then(render)),
);
```

Cap concurrency if you have dozens of keys; a handful in flight at once is
plenty. Keep the ordering only where it carries meaning, such as a GET that
must finish before an UPDATE to the same contract. In a Rust UI, the
browser `WebApi::send` completes once the request is sent and every response
arrives at the single result handler passed to `WebApi::start`, so send each
GET without waiting for the previous response and handle each `GetResponse` or
`NotFound` in that handler as it arrives, matched by key.

**This needs stdlib TS 0.4.0 or later.** From 0.4.0, `api.get()` matches each
response to its request by contract, and a host error rejects only the
requests for the contract it names. Before 0.4.0, concurrent requests for
different contracts could resolve with each other's responses, so one shard's
state could render in another shard's place. On an older version, upgrade
first. If you can't, match responses to requests by key in your own
`ResponseHandler`. A fan-out of many large shards can exceed the 8 concurrent
streams the TS client reassembles (`MAX_CONCURRENT_STREAMS`), so bound it.

## Contract Synchronization and Delegate Messages

Send requests with `WebApi::send(ClientRequest::ContractOp(...))` or `ClientRequest::DelegateOp(...)`. Every response arrives at the single result handler passed to `WebApi::start`, so match responses to requests by contract key. For a working subscribe, update and delegate flow read River's `room_synchronizer.rs` and `chat_delegate.rs`.

Type details that are easy to get wrong: `ContractRequest::Subscribe` takes a `ContractInstanceId`, while `ContractRequest::Update` takes a `ContractKey`; an `UpdateNotification` carries an `UpdateData` (state, delta or both), not a bare delta; and `DelegateRequest::RegisterDelegate` takes a `cipher` and `nonce` that the node ignores, so any bytes will do.

---

## TypeScript + Vite Approach

For teams more comfortable with TypeScript, Vite provides fast iteration with HMR, SCSS support, and familiar npm tooling. The `@freenetorg/freenet-stdlib` TypeScript package provides the WebSocket API with FlatBuffers serialization.

### Vite Configuration

Inject contract hashes and delegate key bytes as compile-time constants through Vite `define`, computed during the build and written to small files. Declare them in `src/vite-env.d.ts` (`declare const __MODEL_CONTRACT__: string;`, `number[]` for the byte arrays).

```typescript
// vite.config.ts (excerpt)
define: {
  __MODEL_CONTRACT__: JSON.stringify(readFileOrDefault("model_code_hash.txt", "DEV_MODE_NO_CONTRACT_HASH")),
  __DELEGATE_KEY_BYTES__: readFileOrDefault("delegate_key_bytes.json", "[]"),
  __DELEGATE_CODE_HASH_BYTES__: readFileOrDefault("delegate_code_hash_bytes.json", "[]"),
},
// CRITICAL: relative base path for sandboxed iframe serving
base: "./",
```

**Why `base: "./"` is critical:** Freenet serves webapp files inside a sandboxed iframe at a path like `/v1/contract/web/{CONTRACT_ID}/`. Absolute paths (`/assets/...`) would resolve against the node root and 404. Relative paths (`./assets/...`) resolve correctly within the iframe.

### WebSocket Connection (TypeScript)

`FreenetWsApi` from the stdlib TypeScript package handles the FlatBuffers encoding. Build the URL as in the Rust example above (derive the scheme too: a shell served over https needs `wss:`), and implement a `ResponseHandler` with the callbacks you need (`onContractGet`, `onContractUpdateNotification`, `onContractNotFound`, `onSubscribeResponse`, `onDelegateResponse`, `onErr`, `onOpen`, `onClose`).

```typescript
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = new URL(`${proto}//${location.host}/v1/contract/command`);

// CRITICAL: pass an empty string as the auth token. In the sandbox iframe cookie
// reading is blocked and the shell injects the token; "" tells FreenetWsApi to
// skip the cookie.
const api = new FreenetWsApi(wsUrl, handler, "");
```

`onOpen` is the point after which it is safe to send requests. `onClose` is a plain close: the SDK does NOT reconnect, so the app decides the reconnect strategy. A delta in `onContractUpdateNotification` arrives as `notification.update` with `updateDataType === UpdateDataType.DeltaUpdate`, and its bytes are in `updateData.delta`.

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

`get`, `put`, `update` and (from stdlib TS 0.4.0) `subscribe` return promises that resolve with the typed response and reject on timeout (default 30 s), connection close, or a host error that names the contract. The legacy callbacks in `ResponseHandler` still fire for the same response. Before 0.4.0, `subscribe()` resolved as soon as the request was sent and never rejected on a refused subscribe (for example the node's per-client subscription cap), so on an older version detect failure through `onSubscribeResponse` and `onErr`. `disconnect` resolves when the request is sent, in every version.

```typescript
const response = await api.get(new GetRequest(contractKey, true));
await api.subscribe(new SubscribeRequest(contractKey, []));
await api.update(new UpdateRequest(contractKey, new UpdateData(UpdateDataType.DeltaUpdate, new DeltaUpdate(Array.from(deltaBytes)))));
```

### Large state handling

Requests over 512 KB are chunked and responses reassembled by the SDK; there is no opt-in. A GET of a multi-MB state is slow regardless (see `state-authorization-patterns.md`, "State Size Budget").

### Delegate Communication (TypeScript)

The public API has no delegate-message builder. Sending one means building the FlatBuffers chain from the internal `-T` table types, which are not in the main export, so import them dynamically (Vite aliases resolve them to the stdlib source):

```typescript
const { ApplicationMessageT } = await import("@freenetorg/freenet-stdlib/common");
const { ClientRequestT, ClientRequestType, ApplicationMessagesT, DelegateKeyT,
        DelegateRequestType, InboundDelegateMsgT, InboundDelegateMsgType } =
  await import("@freenetorg/freenet-stdlib/client-request");

const appMsg = new ApplicationMessageT(payload, [], false);
const inbound = new InboundDelegateMsgT(InboundDelegateMsgType.common_ApplicationMessage, appMsg);
// DelegateKey has TWO fields: key bytes AND code_hash bytes
const delegateKey = new DelegateKeyT(delegateKeyBytes, delegateCodeHash);
const delegateReq = new DelegateRequest(DelegateRequestType.ApplicationMessages,
  new ApplicationMessagesT(delegateKey, [], [inbound]));
// sendRequest is a private method, so reach it with a cast
(api as any).sendRequest(new ClientRequestT(ClientRequestType.DelegateRequest, delegateReq));
```

> **Warning — unstable API:** `(api as any).sendRequest(...)` reaches into a private SDK method because the public delegate-request builder is not exposed by the SDK. This cast may break on any minor SDK bump. Track [freenet-stdlib](https://github.com/freenet/freenet-stdlib) for a public `api.sendDelegateMessage()` (or equivalent) before relying on this in production.

To read a response, iterate `DelegateResponse.values` and keep entries whose `inboundType` is `1` (`OutboundDelegateMsgType.common_ApplicationMessage`); the payload is `(entry.inbound as { payload?: number[] }).payload`.

### Pre-Decoded Key Bytes Pattern

Derive the delegate key bytes and `code_hash` (BLAKE3 of the WASM) at build time from the built WASM (see freenet/raven's `Makefile.toml`, `build-identity`) and inject them as constants. Build the WASM through the canonical script into a throwaway target dir first (`build-system.md` → "Byte-reproducibility"), because a reused `target/` can silently change the bytes and this hash is compiled into the UI.

Vite injects these as `__DELEGATE_KEY_BYTES__` and `__DELEGATE_CODE_HASH_BYTES__` compile-time constants.

### Raven Reference

See [freenet/raven](https://github.com/freenet/raven) (formerly freenet-microblogging) for a complete TypeScript + Vite implementation:
- `web/src/freenet-api.ts` — FreenetWsApi wrapper with GET/UPDATE/SUBSCRIBE
- `web/src/delegate-api.ts` — Delegate FlatBuffers message building
- `web/src/identity.ts` — Identity management (delegate + in-memory fallback)
- `web/vite.config.ts` — Build-time key injection
- `Makefile.toml` — Build pipeline

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
