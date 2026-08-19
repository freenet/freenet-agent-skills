# The Web Container Contract — Your Webapp URL Is Stable

**The one thing to know: a Freenet webapp is upgraded *in place*. Shipping a new
release does not move its URL.** Your UI is the container contract's *state*, not
its code, so publishing v2 is a signed state update at the same address users
already bookmarked.

This is the single most commonly missed fact about publishing on Freenet, and
missing it is expensive: developers who assume the URL rotates go and build a
redirect/pointer contract to paper over a problem that does not exist. If you are
about to write one, read this page first.

## Why the URL doesn't move

A contract key is `BLAKE3(BLAKE3(wasm) || params)`. For a web container:

| Input | What it is | Changes when you ship a new UI? |
|---|---|---|
| `wasm` | The **generic web container contract** — the same pre-built artifact for every site | **No** |
| `params` | Exactly 32 bytes: your Ed25519 **publisher verifying key** | **No** |
| `state` | `[meta_len u64 BE][metadata CBOR][web_len u64 BE][webapp.tar.xz]` — **your entire UI** | Yes, every release |

Both key inputs are fixed, so the key is fixed. The UI lives entirely in the
third row, which is not an input to the key at all. Rebuilding your UI cannot
move your URL, because your UI was never part of your address.

The metadata is `{ version: u32, signature: [u8; 64] }`, and the signature covers
`version.to_be_bytes() || webapp_tar_xz_bytes` — the raw archive, not the packed
state.

**Authorization is split across two entry points, and this matters if you ever
write your own container.** The Ed25519 signature is verified in
**`validate_state`**, against the publisher key in `params`. Version monotonicity
(strictly greater than the stored version) is enforced in **`update_state`**,
which does *not* look at signatures at all. Neither is self-securing; the pair is
sound only because the node runs `validate_state` on the update path too. If you
fork a container contract, do not assume `update_state` is guarding anything.

Net effect: whoever holds the signing key can replace the site's content forever,
at one permanent address.

River is the standing proof. Its UI has lived at
`raAqMhMG7KUpXBU2SxgCQ3Vh4PYjttxdSWd9ftV7RLv` across many dozens of releases,
publishing each one with the *same* committed `web_container_contract.wasm` and
the *same* committed `webapp.parameters`.

## Publishing: use `fdev website`

freenet-core ships a generic website contract and a CLI for it. You do **not**
need to write a container contract, a signing tool, or a build pipeline. Verified
against `fdev` 0.3.273:

```bash
# Once, ever. Generates an Ed25519 keypair, saves it under your platform config
# dir, and prints the contract key/URL it will publish to.
#   Linux: ~/.config/freenet/website-keys/<name>.toml
#   macOS: ~/Library/Application Support/freenet/website-keys/<name>.toml
fdev website init my-app

# fdev writes that file with default permissions. Tighten it yourself.
chmod 600 ~/.config/freenet/website-keys/my-app.toml

# v1.
fdev website publish ./dist/ --key my-app

# v2, v3, v50 — same command shape, SAME URL. No redirect, no pointer, no
# bookmark churn. `update` calls the same code path as `publish`; the only
# difference is that the new state carries a higher version.
fdev website update ./dist/ --key my-app

# Your keys and the contract key each one owns. Caveat if you pin the container
# WASM with --contract-wasm: `list` ignores the pin. See below.
fdev website list
```

The directory must contain an `index.html`. `fdev` tars it, xz-compresses it,
signs `version || archive_bytes`, and sends a **`ContractRequest::Put`** — for
updates too. A `ContractRequest::Update` does exist in the client API; `fdev
website` simply doesn't use it, and lets the node merge instead. On a re-PUT the
node runs **both** `update_state` (merge, which enforces the version bump) and
`validate_state` (which enforces the signature).

## Versioning

The version is a **`u32`**, signed as 4 big-endian bytes. `update_state` requires
each new version to be **strictly greater** than the stored one (`<=` is
rejected); `validate_state` additionally rejects `0`, so versions are 1-based.
Gaps are fine — only strict monotonicity is enforced.

`fdev website` derives the version from unix seconds and takes no version
argument, which is fine for ordinary use. Two failure modes are worth knowing,
both observed on **River's own bespoke signing pipeline** rather than on `fdev
website`:

- **Same-granularity ties.** River and freenet-email used `unix_seconds / 60`, so
  two publishes in one minute produced the same version. The consequence is
  nastier than a clean rejection: the publisher's own node accepts and serves the
  new build, while **subscribed peers reject the broadcast and keep serving the
  old one indefinitely** — so it looks published to you and stale to everyone
  else. That is freenet-core#4064, still **open**, and the minute-collision is
  the leading hypothesis rather than a confirmed cause. `fdev`'s move to
  second-granularity is the lesson learned from it.
- **A version from the future.** River's on-network version reached a round
  30000208 while its scheme was generating ~29649402 — either clock skew or a
  hand-bump, and River's own notes hedge between the two. Either way the site was
  unpublishable until versions caught up, a gap of roughly 243 days. Recovery was
  **manual**: seed a committed counter above the stuck value (River seeded
  30000300). Nobody waits this out.

**Do not switch schemes casually, and never switch downward.** This is the one
mistake on this page that permanently bricks a live site:

> `fdev website` versions are unix **seconds** — currently ~1.78e9. A fresh
> counter seeded at `1`, or at a River-style value (~3.0e7), is
> **far below** the stored version, so `update_state` rejects it and every
> subsequent publish, forever. There is no recovery: you cannot lower the stored
> version, and the address is derived from your key, so the site is frozen.

If you do need your own scheme — publishing from CI, from more than one machine,
or more than once a second — then:

1. **Read the current on-network version first** and seed your counter strictly
   above it. River's Makefile hard-errors rather than let you skip this step; its
   own counter is small only because that pipeline predates the seconds scheme.
2. **Never mix the two schemes in either direction** on one contract.
3. Understand that `fdev website publish|update` accept **no version flag**
   (`generate_version()` is unconditional), so this means **leaving `fdev
   website` and signing yourself** — River's route, via its own
   `web-container-tool sign --version` fed from a committed
   `contract-version.txt`, which `build-system.md` documents as the legacy path.

Keep any hand-rolled counter well under 2^32. Unix-seconds versions themselves
overflow `u32` in 2106.

## What *does* move the URL (and how to not let it)

Only two things, neither of which is a UI release:

1. **The container WASM changes.** A newer `fdev` may embed a newer
   `website_contract.wasm`, which re-keys. `--contract-wasm <path>` lets you keep
   publishing against the exact container artifact your site was created with.

   **This is a genuine trade-off, not a free win.** Pinning buys a permanently
   stable address and costs you a frozen third-party contract implementation: the
   upstream container has already changed several times, and a pinned copy can
   never receive fixes to `validate_state` / `update_state` / `summarize_state` /
   `get_state_delta` — including the summary/delta path that governs how your
   updates propagate and heal. A pinned copy would also be stranded outright if
   the runtime ever retires that contract API version. Decide deliberately: pin
   if a stable URL is the higher value (a published site with real users),
   float if you would rather track upstream (early development, no audience yet).

   If you pin, two practicalities the CLI does not help with:

   - **Do not rebuild the container from source to get the file.** WASM builds
     are not byte-reproducible, so a rebuild yields different bytes, a different
     key, and a silent publish to a brand-new URL while you believe you pinned
     the old one. The WASM is `include_bytes!`-embedded in `fdev` with no export
     subcommand, so the only correct source is
     `crates/fdev/resources/website_contract.wasm` from the freenet-core repo **at
     the tag matching your `fdev --version`**. Copy it out on day one; if you
     upgrade `fdev` before extracting it, there is no documented way to recover
     the original artifact.
   - **`fdev website list` and `init` ignore your pin.** Both always derive the
     key from fdev's built-in WASM. They are correct when you first run them, and
     start printing a *different* key for the same key file after an fdev
     upgrade. Record your contract ID at first publish and trust that, not
     `list`.
2. **The publisher key changes.** Your key *is* half your address. Rotating it is
   a new site, not an upgrade.

**Losing the signing key is unrecoverable.** `params` holds only the public half,
so with the private half gone no future state can ever verify: the site is frozen
at its last published version, permanently, with no way to migrate it, and no
facade or redirect can rescue it either (that indirection needs its *own* live
key to flip).

Treat the key like a CA root, before your first publish:

- **Back it up in three independent places** — password manager, encrypted
  offline media, and a printed copy in physical storage. Not one, not two.
- **Decide custody up front if more than one person will publish.** A key that
  lives only on one laptop means one broken laptop ends the site.
- **Never commit it**, and `chmod 600` it — `fdev website init` writes it with
  default permissions, not 0600. Add a pre-commit check if the key ever lives
  near a repo path.
- **Know where it actually is on your platform.** The path follows the OS config
  dir, so on macOS it is `~/Library/Application Support/freenet/website-keys/`,
  not `~/.config`. Backing up the wrong path is indistinguishable from having a
  backup until the day you need it.

## Rehearse before your first production publish

The publish is signed and permanent, so do a dry run against a **local node**
first (`fdev` defaults to `127.0.0.1:7509`). Publish the site under a
throwaway key, load it in a browser through the gateway, then do a second
publish to confirm the update path works and lands at the same URL. Only then
run `fdev website init` for the key you intend to keep.

This catches the two mistakes that are expensive later: a broken or empty
archive (missing `index.html`, wrong build output directory), and a version
scheme that can't produce a strictly greater number on the second publish. See
`production-smoke-testing.md` for verifying a published site actually mounts.

## Size budget

The node enforces a hard `MAX_STATE_SIZE` of **50 MiB** on total state. Above
roughly 64 MiB serialized you hit a second, far more cryptic failure — a
WebSocket chunk-count cap reporting `total_chunks N exceeds maximum 256`
(freenet-core#4653). `fdev website publish` pre-flights the 50 MiB limit so you
get a clear error instead.

Treat 50 MiB as a wall, not a target. The whole state transfers before the page
renders, so a fat bundle is felt directly as load latency by every visitor. Serve
large media from their own contracts rather than packing it into the site
archive.

Ignore the larger figure written into the container contracts themselves —
both freenet-core's bundled website contract and River's declare a
`MAX_WEB_SIZE` of 100 MiB, which can never bind because the node's 50 MiB cap
stops you first. freenet-core#4653 tracks these three inconsistent ceilings (50
MiB store, ~64 MiB transport, 100 MiB contract); the only one to design against
is 50 MiB.

## Do not build a redirect contract

If your reason for a pointer/redirect/facade contract is *"my URL changes every
release"* — it doesn't, and the indirection buys you nothing while costing a
whole extra contract, an extra signing key, a loader page, an iframe navigation
dance, and a gateway cache-busting step on every release.

There is one narrow case where an indirection is genuinely the answer: you need
to move an existing audience to a **different contract** — a container WASM
migration you cannot do with `--contract-wasm`, or a publisher-key rotation. That
is a rare, deliberate event, not release mechanics. See `facade-pattern.md`.
Pinning your container WASM (above) removes the first of those two causes, at
the cost of freezing the container implementation — weigh it there rather than
reaching for it reflexively.

## This does not make your *data* contracts stable

Container stability is about your **UI's address**. Your app's data contracts are
separate, and a change to *their* WASM does re-key them — that is what
`upgrade-and-migration.md` is about. The two are independent:

- New UI, unchanged data contracts → in-place update, nothing else to do.
- Data contract WASM changes → register the outgoing code hash and let clients
  migrate state forward, per `upgrade-and-migration.md`. Your webapp URL is
  unaffected either way.

## Cross-references

- `facade-pattern.md` — the narrow "move to a different contract" case.
- `build-system.md` — packaging the archive, signing, and keeping the container
  WASM byte-stable.
- `upgrade-and-migration.md` — the separate problem of migrating *data contract*
  state across a re-key.
- `production-smoke-testing.md` — verifying a published site actually mounts.
