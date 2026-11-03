# Facade Contract Pattern — Moving an Audience to a Different Contract

> Read `web-container-contract.md` first. You probably do not need this. Ordinary
> releases are in-place state updates at a permanent address
> (`fdev website update`), so a facade adds a second contract, a second signing
> key, a loader page and a navigation hop to solve nothing.

## When this pattern is actually justified

Only when you must point an existing audience at a **genuinely different
contract**, which is a deliberate, rare event rather than release mechanics:

- **A container-WASM migration you can't avoid.** A newer `fdev` embeds a newer
  website contract, which re-keys. The cheap fix is to commit your container
  WASM and pass `--contract-wasm` forever (see `web-container-contract.md`); the
  facade is for when you have decided to move to the new container and want old
  bookmarks to follow.
- **A publisher-key rotation.** The key is half the address, so rotating it is a
  new site. If the old key is compromised rather than lost, a facade can forward
  from the old address to the new one.

Two limits, both load-bearing:

- **A facade cannot rescue a *lost* signing key.** Whichever contract holds your
  audience's bookmark needs a live key to flip its pointer.
- **For the *compromise* case the facade needs its OWN key.** One key for both
  the web container and the facade halves what you have to back up, but a
  compromise then takes the facade with it, and your escape hatch is gone exactly
  when you need it. If you are adopting a facade *in order to* survive key
  rotation, give it a separate key, stored separately. Use one key for both only
  if the facade exists for a container-WASM migration. Choose between these two
  postures deliberately; they are mutually exclusive.

The reference implementation is freenet/mail (`contracts/facade`,
`contracts/facade-types`, `contracts/facade-loader`).

## What you build

Three pieces: a tiny shared types crate (`FacadePointer { version: u64,
current_app_id, prev_app_ids }` plus a signed payload), the on-chain facade
contract, and a static loader page that the facade serves as its web slot. The
facade contract's `update_state` verifies the signature, requires
`new.version > current.version` (seed above the last published value if you ever
switch version schemes; see `web-container-contract.md`), and moves
`current_app_id` into a bounded `prev_app_ids` ring for rollback. Its state uses
the same `[meta_len][meta][web_len][web]` framing as a web container, with the
loader as the web slot.

The facade WASM must be byte-stable, because its contract ID is the bookmark.
Keep it in its own workspace with its own lockfile and a minimal dependency
closure (`build-system.md` → "Per-contract lockfile isolation"), commit the WASM,
its parameters (the verifying key) and its contract ID, and have CI rebuild it
and compare bytes. A mismatch is a release blocker. If it is a real dependency
or toolchain bump, regenerating the snapshot rotates the facade ID and breaks
every bookmark, so announce it. Otherwise suspect a machine-specific path or a
stale `target/` (`build-system.md` → "Byte-reproducibility"). Do not regenerate
the snapshot under emulation (macOS/arm64 against linux/amd64 CI can differ):
take the bytes from CI's artifact and recompute the ID with
`fdev get-contract-id --code ... --parameters ...`.

## The loader

```html
<script>
const target = "/v1/contract/web/{{CURRENT_APP_ID}}/";   // substituted at build time
let framed;
try { framed = window.parent !== window; } catch (e) { framed = true; }
if (framed) {
  // Inside the gateway shell iframe: ask the shell to navigate the top window.
  window.parent.postMessage({ __freenet_shell__: true, type: "navigate", href: target }, "*");
} else {
  window.location.replace(target);   // opened standalone, no shell
}
</script>
<noscript>Open the current app at <a href="/v1/contract/web/{{CURRENT_APP_ID}}/">this link</a>.</noscript>
```

Do not use `location.replace` from inside the shell iframe: the browser would
load the new contract's shell page inside our frame, and that page is
`X-Frame-Options: DENY`, so you get a blank page and a frame-ancestors error. Do
not branch on `__sandbox=1`: the gateway's iframe URL always carries it.

## fdev gotcha: `--as-state` is required

`fdev execute update` wraps the file as `UpdateData::Delta` by default. The
facade's `update_state` accepts only `UpdateData::State`, so without `--as-state`
the pointer is never flipped, with no visible failure. Always use
`fdev execute update --as-state "$FACADE_ID" <state-file>`.

## Flipping the pointer

Only when the new container ID is genuinely different (container-WASM migration
or key rotation). Publish the new web container first and confirm it serves
(HTTP 200 at its URL). Then re-render the loader with the new ID, pack it, sign a
fresh pointer with the production key, and push it with
`fdev execute update --as-state <FACADE_ID> <state-file>`. Never commit the signed
state file: it holds a per-build timestamp. Gate any release
script on the container ID having changed; an unconditional flip burns a version
number re-publishing the address it already holds. If a script dies between
publishing the container and flipping the pointer, confirm the container serves,
then redo the sign and push steps; the container publish is idempotent. Finish
with a fresh browser load of the facade URL.

## Signing key

Custody rules are those in `web-container-contract.md` ("Losing the signing key
is unrecoverable"). One addition: the facade's verifying key is in its
`parameters`, so rotating it rotates the facade ID, which defeats the point. For
whether the facade shares the container's key, see the two postures under "When
this pattern is actually justified".

## Cross-references

- Lockfile isolation that keeps facade WASM byte-stable: `build-system.md`
  → "Per-contract lockfile isolation".
- The two-message gateway shell architecture and CSP gotchas:
  `ui-patterns.md` → "Two Connection Models".
- Smoke-testing the facade URL after release:
  `production-smoke-testing.md`.
