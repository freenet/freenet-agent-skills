# Facade Contract Pattern — Stable URLs Across Releases

## Why

A Freenet web-container contract ID is `hash(wasm, parameters)`. Every
release rebuilds the UI → produces new WASM → produces a new contract
ID → produces a new gateway URL.

This is fine for early development, but it's hostile to users: every
bookmark, every shared link, every external integration breaks the
moment you ship. There's no DNS-equivalent to forward them.

The **facade pattern** gives you a contract ID that stays byte-stable
across every release. Users bookmark the facade URL once; per-release
updates flip a pointer inside the facade's state to whatever the
current web-container ID is. The facade WASM itself is never rebuilt.

This is the pattern freenet/mail uses (issue #200). It is the
recommended approach for any Freenet dApp that expects to ship more
than one release.

## Architecture

Three pieces:

```
contracts/facade-types/         # tiny shared crate, types only
contracts/facade/               # the on-chain facade contract (stable WASM)
contracts/facade-loader/        # static HTML+JS shell the facade serves
published-contract/
├── facade.wasm                 # committed snapshot — never rebuilt per release
├── facade.parameters           # 32 bytes: ed25519 verifying key
├── facade-id.txt               # the stable contract ID users bookmark
├── webapp.wasm                 # web-container WASM — rebuilt every release
├── webapp.parameters
└── contract-id.txt             # web-container ID — rotates every release
```

### `contracts/facade-types/`

A tiny crate shared between the facade contract and the host-side
signer. Dependencies: `ed25519-dalek`, `serde`. Nothing else. The
smaller this crate's dependency closure, the less likely a workspace
bump can rotate the facade WASM bytes (see `build-system.md` →
"Per-contract lockfile isolation").

```rust
// contracts/facade-types/src/lib.rs
pub const FACADE_MAX_PREV_APP_IDS: usize = 8;

#[derive(Serialize, Deserialize)]
pub struct FacadePointer {
    pub version: u64,                       // unix timestamp at signing time
    pub current_app_id: ContractInstanceId, // the web-container to serve now
    pub prev_app_ids: Vec<ContractInstanceId>, // ring buffer for rollback
}

#[derive(Serialize, Deserialize)]
pub struct FacadeMetadata {
    pub pointer: FacadePointer,
    pub signature: [u8; 64],   // ed25519 over signed_payload(pointer)
}

/// Canonical byte serialization used as the signature payload. Hand-rolled
/// rather than CBOR/bincode to sidestep map-ordering / encoding concerns.
pub fn signed_payload(p: &FacadePointer) -> Vec<u8> { /* ... */ }
```

### `contracts/facade/`

The on-chain contract. Stable WASM. Its `update_state` accepts a new
signed `FacadeMetadata`, verifies the signature with the embedded
verifying key, checks `new.version > current.version` (strictly
monotonic — same constraint as the web-container), and updates the
`current_app_id`. The previous `current_app_id` is pushed onto
`prev_app_ids` (ring buffer of size `FACADE_MAX_PREV_APP_IDS`).

State framing matches the web-container's `[meta_len][meta][web_len][web]`
layout — `meta` carries the `FacadeMetadata`, `web` carries the loader
tar.xz.

### `contracts/facade-loader/`

A static HTML+JS shell that the facade serves as its `web` slot.
Per-release the loader is re-rendered with the new web-container ID
baked in, tarred, xz-compressed, and packed into the new facade state.

```html
<!-- contracts/facade-loader/src/index.html.tmpl -->
<!doctype html>
<html><head><meta charset="utf-8"><title>Loading…</title></head>
<body>
<script>
const CURRENT_APP_ID = "{{CURRENT_APP_ID}}";  // substituted by build-loader.sh
const target = `/v1/contract/web/${CURRENT_APP_ID}/`;

if (window.parent !== window && !location.search.includes("__sandbox=1")) {
    // Running inside the gateway's shell iframe.
    window.parent.postMessage(
        { __freenet_shell__: true, type: "navigate", href: target },
        "*"
    );
} else {
    // Standalone (dev / ?__sandbox=1 / no parent). Direct redirect.
    window.location.replace(target);
}
</script>
<noscript>Open <a href="${target}">${target}</a> manually.</noscript>
</body></html>
```

## Per-release flow

`scripts/release.sh` chains these automatically. Manually:

```bash
# 1. Build the new web-container webapp (rotates contract-id.txt).
cargo make build
NEW_APP_ID=$(cat published-contract/contract-id.txt)
FACADE_ID=$(cat published-contract/facade-id.txt)

# 2. Re-render the loader with the new ID baked in.
scripts/build-loader.sh "$NEW_APP_ID"
# → contracts/facade-loader/dist/index.html

# 3. Pack the loader into the format the gateway expects.
cargo make pack-facade-loader
# → target/facade/loader.tar.xz

# 4. Sign a fresh FacadePointer with the production key.
cargo make sign-facade-state
# → target/facade/facade.state  (FacadeMetadata { pointer, signature } framed)

# 5. Push the new state to the facade contract.
#    --as-state is REQUIRED (see "fdev gotcha" below).
fdev execute update --as-state "$FACADE_ID" target/facade/facade.state
```

After step 5 the facade URL at
`http://127.0.0.1:7509/v1/contract/web/$FACADE_ID/` redirects to the new
webapp. The facade contract ID is unchanged.

## fdev gotcha: `--as-state` is required

```bash
# WRONG — fdev wraps the file as UpdateData::Delta, the facade contract's
# update_state matches Delta(_) => Err(InvalidUpdate), and the gateway
# returns success silently. The pointer is never flipped.
fdev execute update "$FACADE_ID" target/facade/facade.state

# RIGHT — wraps as UpdateData::State, which is what update_state matches.
fdev execute update --as-state "$FACADE_ID" target/facade/facade.state
```

Preflight your release script so it fails loud if the local `fdev` is too
old:

```bash
if ! fdev execute update --help 2>&1 | grep -q -- '--as-state'; then
    echo "error: fdev does not support --as-state — install a release built" >&2
    echo "from a freenet-core that has it. See build-system.md → installing fdev." >&2
    exit 1
fi
```

## Loader: postMessage, NOT location.replace

The gateway wraps every contract URL in a shell page with
`X-Frame-Options: DENY`, serving the contract's web slot inside a
sandboxed iframe. The shell page is what holds the navigation address bar
(metaphorically) and listens for `__freenet_shell__` messages from
contract code.

If the loader does `location.replace(target)` from inside the sandbox,
the browser tries to load the *new contract's shell page* INSIDE our
iframe. The new shell page also has `X-Frame-Options: DENY` — so the
browser blocks it. You see a blank page and a console error about
frame-ancestors.

The right way is to `postMessage({type:"navigate", href}, "*")` to
`window.parent` and let the gateway's shell handle the cross-contract
navigation in the top window.

Keep a fallback path for development / `?__sandbox=1`: if `window.parent
=== window` or the sandbox flag is set, use `location.replace` directly.
That's how you smoke-test the loader without a gateway.

## Gateway cache busting after a pointer flip

The gateway extracts a contract's tar.xz on `GetResponse`, caches the
extracted files to disk, and serves subsequent requests from cache.
**UPDATEs that change the `web` slot do not invalidate the cache** until
the next GET hits a cache miss. Right after a pointer flip, browsers
hitting `…/web/$FACADE_ID/` see the old loader (pointing at the previous
app) until the cache TTL expires.

Bust it manually after every flip until upstream fixes this:

```bash
# macOS
CACHE="$HOME/Library/Caches/The-Freenet-Project-Inc.freenet/webapp_cache"
# Linux
CACHE="$HOME/.cache/freenet/webapp_cache"

rm -rf "$CACHE/$FACADE_ID" "$CACHE/$FACADE_ID.hash"

# Trigger a fresh GetResponse to repopulate.
curl -s -o /dev/null "http://127.0.0.1:7509/v1/contract/web/$FACADE_ID/"
```

(Track this as a freenet-core gateway issue the next time you hit it.)

## What to commit, what to ignore

Commit:

- `published-contract/facade.wasm` — the canonical, byte-stable artifact.
- `published-contract/facade.parameters` — the 32-byte verifying key.
- `published-contract/facade-id.txt` — the contract ID derived from the
  two above.

Do NOT commit:

- `target/facade/facade.state` — signed with the production key, includes
  a per-build timestamp version. Re-signed every release. Committing it
  bloats history and leaks signing-machine timestamps.
- `contracts/facade-loader/dist/index.html` — regenerated from
  `index.html.tmpl` at every release. Edit the `.tmpl`, let
  `build-loader.sh` re-render.

## CI byte-equality enforcement

The whole point of the facade is that its WASM is byte-stable. CI must
enforce that. In `.github/workflows/check-contract-wasm.yml`:

```yaml
- name: Rebuild facade WASM and compare against committed snapshot
  run: |
    scripts/build-facade-snapshot-linux.sh
    cmp published-contract/facade.wasm target/facade-build/facade.wasm \
      || { echo "::error::facade.wasm drift — see facade-pattern.md"; exit 1; }
```

Failure here is a release blocker. Possible causes:

1. **Someone bumped a dependency in `contracts/facade/Cargo.toml` or
   `contracts/facade-types/Cargo.toml`.** If deliberate (e.g. a security
   fix in `ed25519-dalek`), regenerate the snapshot using the recipe
   below and update `facade-id.txt` in the same PR. Announce loudly — the
   stable URL is rotating, every bookmark breaks.
2. **`rust-toolchain.toml` pin changed.** Same as above.
3. **A workspace dep leaked in** because the facade isn't actually in
   `[workspace.exclude]` or doesn't have its own `Cargo.lock`. See
   `build-system.md` → "Per-contract lockfile isolation".

### Regenerating the facade snapshot from a non-Linux host

CI builds on linux/amd64. If your dev box is macOS/arm64, qemu
emulation can produce subtly different WASM bytes from CI's native
build. Don't fight it. Use a CI-bootstrap flow:

```bash
# 1. Push the change with a placeholder facade.wasm (any non-empty file).
#    The byte-equality check WILL fail; that's fine.

# 2. CI's job uploads the freshly built facade.wasm as an artifact
#    (e.g. named "facade-wasm-rebuilt-<sha>").
RUN_ID=$(gh run list --workflow check-contract-wasm.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run download "$RUN_ID" -n "facade-wasm-rebuilt-${SHA}" -D /tmp/facade-rebuilt

# 3. Replace the committed snapshot with CI's output.
cp /tmp/facade-rebuilt/facade.wasm published-contract/facade.wasm

# 4. Recompute the contract ID.
fdev get-contract-id \
    --code published-contract/facade.wasm \
    --parameters published-contract/facade.parameters \
    > published-contract/facade-id.txt

# 5. Commit, push. CI now passes.
git add published-contract/facade.{wasm,id.txt}
git commit -m "chore(facade): regenerate snapshot from CI build"
```

Local `check-facade-byte-equal.sh` should skip with a warning on
non-canonical hosts so devs aren't blocked by emulation drift.

## Production key lifecycle

The facade's verifying key is embedded in its `parameters` blob —
**rotating the key rotates the facade contract ID.** The whole point of
the facade is to never do that. So the signing key needs the same care
as a long-lived CA root.

```bash
# One-time, on a trusted machine.
scripts/generate-production-key.sh
# → ~/.config/freenet-email/web-container-keys.toml (chmod 600)
```

Rules:

- **Never commit** the signing key. Add the config path to `.gitignore`
  and add a pre-commit check that refuses to stage it.
- **Back it up offline immediately.** Password manager + encrypted USB
  + printed QR in a physical safe. Pick three of those, not just one.
  Losing the key means generating a new one, regenerating the facade
  snapshot, publishing a new facade contract with a new ID, and
  notifying every user that their bookmark is dead.
- Override path with `WEB_CONTAINER_KEY_FILE=/path/to/keys.toml` if you
  use a hardware token / agent that exposes the key under a different
  path.
- The same key signs both the web-container `webapp.metadata` and the
  facade's `FacadeMetadata`. They're two contracts with the same
  publisher identity. Don't generate separate keys; you'll just have two
  things to back up and your operational risk doubles.

## Recovery: manual pointer flip after script failure

`scripts/release.sh` is idempotent up to step 7 (commit) — if it dies
between publishing the new webapp and flipping the facade pointer
(e.g. fdev's default 300s timeout fires even though the gateway accepted
the request), recover manually:

```bash
NEW_APP_ID=$(cat published-contract/contract-id.txt)
FACADE_ID=$(cat published-contract/facade-id.txt)

# 1. Confirm the new webapp actually landed.
curl -sI "http://127.0.0.1:7509/v1/contract/web/$NEW_APP_ID/" | head -1
# Expect: HTTP/1.1 200 OK

# 2. Re-render loader + re-sign pointer.
cargo make sign-facade-state

# 3. Push the pointer update.
fdev execute update --as-state "$FACADE_ID" target/facade/facade.state
# Expect: "Contract updated successfully"

# 4. Bust the gateway cache (see above).

# 5. Verify the pointer in the loader.
curl -s "http://127.0.0.1:7509/v1/contract/web/$FACADE_ID/?__sandbox=1" \
    | grep "$NEW_APP_ID"
# Expect: the new app ID appears in the rendered loader.

# 6. Browser smoke: open the facade URL, watch DevTools network tab,
#    confirm postMessage navigation lands on the new web-container.
```

If step 1 returns anything other than 200, the publish itself failed
mid-flight; do not flip the pointer. Re-run from `cargo make
publish-production` — the publish step is idempotent (PUTting an already
published contract is a no-op).

## Cross-references

- Lockfile isolation that keeps facade WASM byte-stable: `build-system.md`
  → "Per-contract lockfile isolation".
- Why the contract ID is not reproducible from source: `build-system.md`
  → "Contract ID reproducibility caveat".
- The two-message gateway shell architecture and CSP gotchas:
  `ui-patterns.md` → "Two Connection Models".
- Smoke-testing the facade URL after release:
  `production-smoke-testing.md`.
