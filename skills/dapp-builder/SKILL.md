---
name: dapp-builder
description: Build and maintain decentralized applications on Freenet using river as a template. Guides through designing contracts (shared state), delegates (private state), and UI, and through upgrading a live dApp safely. Use when user wants to create a new Freenet dApp, design contract state, implement delegates, build a Freenet-connected UI, OR upgrade an existing dApp — bump freenet-stdlib, ship a new contract/delegate version (v2), fix a bug that re-keys the WASM, or migrate state across a contract/delegate key change without breaking invites or losing data. Also use when INTEGRATING with a contract or delegate published by another app — reading another project's contract state, depending on a platform delegate, or deciding how to address someone else's artifact so it survives their re-keys.
license: LGPL-3.0
---

# Freenet dApp Builder

Build decentralized apps on Freenet. [River](https://github.com/freenet/river) is the
reference app: `contracts/room-contract/`, `delegates/chat-delegate/`, `ui/`, `common/`.

This file holds the model, the rules for every dApp, and the route to the right reference.
Read the reference for your task before writing code.

## The model

An app has three kinds of component, and most real apps have several contracts and delegates.

- **Contract:** WASM defining the shape and merge rules of shared state. It runs on untrusted
  peers and cannot hold secrets; all state is public unless the client encrypted it. The WASM
  is a table schema, and each parametrized instance is a row with its own key and state.
- **Delegate:** WASM on the user's node that holds secrets and does signing and encryption. It
  runs only when poked: an app message, a contract notification, or an event its manifest
  declares.
- **UI:** a web app talking to the local node over WebSocket, published as the *state* of a web
  container contract.

A key is `BLAKE3(BLAKE3(wasm) ‖ params)`. Any WASM change, including a dependency or compiler
bump, moves the key. Most of the rules below follow from that.

Freenet has no supported full node on mobile, so "native app" means desktop. Do not generate a
production mobile wrapper without warning about bandwidth, battery, thermal, CPU and
background-execution problems. Treat it as experimental, require resource measurements, and do
not present it as an official Freenet client without the Freenet Project's approval.

## Rules for every dApp

**Contract state**

1. `update_state` is the merge. It must be associative, commutative and idempotent on exact
   bytes, over every state `validate_state` accepts, not only those your clients produce.
   Delivery is at-least-once, so a re-delivered delta must be absorbed too: applying it again
   must not change the state. Read `merge-law-compliance.md` before adding a cap, removal or
   work bound.
2. Check it: `fdev verify-merge --wasm c.wasm --params params.bin --state s1.bin --state s2.bin`.
   Without `--params`, a contract whose parameters do not decode from empty bytes comes back
   all inconclusive and still exits 0. Inconclusive is not a pass.
3. A contract must not read the host clock (`freenet_stdlib::time::now()`): the merge has to be
   a function of its inputs, and the call is staged to trap (freenet-core#5465). Carry a
   client-signed timestamp and enforce only monotonicity. It is an untrusted hint. Delegates
   may read the clock.
4. Use `BTreeMap`/`BTreeSet`, never `HashMap`/`HashSet`, in state and summaries. Peers decide
   they have converged by comparing bytes.
5. `get_state_delta` to an up-to-date peer returns an empty delta, never anything near state
   size, and a summary must be far smaller than the state. Test convergence through
   `summarize` / `delta` / `apply`; do not assume a broadcast reaches every peer.
6. Every field in state must be covered by a cryptographic signature, because peers can edit
   anything unsigned. Test that tampering with each signed field fails verification.
7. `validate_state` must reach the same verdict on the same bytes forever. Reading another
   contract is safe only for immutable or once-true-always-true facts; gating validity on
   mutable state makes peers disagree permanently.
8. Keep each data contract instance well under 4 MB (the hard cap is 50 MiB): a GET transfers all
   of it before the UI can render. Shard unbounded data by the unit of write concurrency.

**Keys and upgrades**

9. Anchor every durable reference (invites, links, membership) on an identity independent of
   the WASM, such as an owner key, and re-derive the contract key from it. With that, a routine
   stdlib bump migrates on refresh and invites keep working. Never recreate instances or warn
   of dead invites for a routine re-key.
10. A new contract version must accept old state, so that any client can carry a user forward.
    Keep a committed registry of past code hashes and use the `freenet-migrate` release matching
    your stdlib (table in `build-system.md`); do not hand-roll the sweep. Once you have users,
    changing how a record's id is derived is a breaking change to their data.
11. A delegate migration is forward-only. There is no node-level mechanism today. Do not wait
    for one: migrate at the app level. Status is tracked in freenet-core#2776. A predecessor's
    secrets are recoverable only if its deployed WASM answers an export request, in practice
    `freenet_migrate::handle_export_request`, or a protocol general enough to enumerate its
    secrets. Every release shipped without that answer is a permanently unrecoverable
    generation. Ship it from v1.
12. Build WASM through one canonical script that remaps `CARGO_HOME`, `RUSTUP_HOME` and the repo
    root and refuses a build that leaks a machine path, and isolate contract lockfiles so
    `cargo update` cannot re-key anything. The WASM bytes are the address.
13. Never hardcode the key of a contract or delegate you do not own, including one from a crate
    you pinned. It moves on every re-key of theirs. A stale delegate key returns a typed
    missing-delegate error, or reads as empty if the old delegate is still registered, and
    either is easy to misread as "this user has nothing stored". Fetch the key at runtime. The
    one exception is a pointer that resolves to `NeverPublished`, which permits a baked-in key
    (`building-on-other-apps.md`). On an existing app, grep for such constants first.

**Publishing and the UI**

14. A webapp's URL is permanent. `fdev website init` once, then `fdev website publish` or
    `update` for each release. Do not build a redirect contract. Back up the signing key on day
    one: lose it and the site is frozen forever.
15. Vendor stylesheets, fonts and scripts. The gateway's same-origin CSP blocks CDNs in
    production even though they work under `dx serve` and `vite dev`.
16. Drive the UI in a real browser from the first screen, with a clean console asserted in every
    flow. Test delegate contract access on a real node: `freenet local` never services a
    delegate's contract requests, so they silently do nothing there.

**Raise with the developer before the first publish**

17. Author contact and source: every dApp should show a way to reach its author and find its
    source. If the UI has neither, stop and ask. See `ui-patterns.md` → "Author Contact and Source".
18. Illegal material: anything showing content other people published needs a way to identify
    and remove it, or it risks delisting from Atlas and a link ban in the Freenet Official River
    room. A contract-level removal must be designed in at v1, as a tombstone. See
    `state-authorization-patterns.md` → "Removing Illegal Material".
19. Anti-flood: if strangers can write, gate a service that spends resources per request on
    ghost keys. An action that must stay free, such as reporting, offers a slow proof-of-work as
    the fallback, shown after the ghost-key option. Tell the developer that ghost keys cost users
    money, that money goes to Freenet, and that the mint is centralized, then ask and wait for the
    developer's decision before wiring it in. See `sybil-resistance.md` → "Cryptographic CAPTCHA".

## Where to read

All paths are under `references/`.

| Task | Read |
|---|---|
| Design contract state; `ContractInterface`, composable state, summaries, deltas, record identity | `contract-patterns.md` |
| Make a merge lawful by construction; caps, removals, work bounds, summary distinctness | `merge-law-compliance.md` |
| Signatures, replay protection, time, related contracts, tombstones, removal, caps, state size, wire-format stability | `state-authorization-patterns.md` |
| User-facing identifiers | `identity-and-addressing.md` |
| Stopping floods of keys: ghost keys and proof-of-work | `sybil-resistance.md` |
| Write a delegate: messages, secrets, permissions, background runs | `delegate-patterns.md` |
| Carry delegate secrets across a re-key | `delegate-migration.md` |
| Build the UI (Dioxus or TypeScript + Vite), WebSocket, CSP, efficient reads, author contact | `ui-patterns.md` |
| Crate layout, dependency versions, reproducible WASM, lockfile isolation, CI | `build-system.md` |
| Test tiers, browser validation, iframe shell, post-publish smoke test | `production-smoke-testing.md` |
| Publish or update the webapp | `web-container-contract.md` |
| Move an audience to a different contract (rare; not for ordinary releases) | `facade-pattern.md` |
| Upgrade a live app: stdlib bump, new contract or delegate version, a fix that re-keys | `upgrade-and-migration.md`, start at "Upgrading a Freenet dApp: the painless path" |
| Depend on a contract or delegate you do not own | `building-on-other-apps.md` |

Run a node and debug against it with the `local-dev` skill.

## Building a new dApp

1. **Contracts.** Each kind of shared state is its own contract crate. For each, settle first:
   the merge when two users write at once; the parameters that distinguish instances; the
   user-facing identifier (short, self-certifying, derived from a key, never a contract key);
   how a record is identified (derive ids from content in the contract, covering every term a
   reader relies on, because a writer-chosen id allows two records under one id, which is
   permanent divergence under first-writer-wins); who can write; who can remove; how large it
   grows and how readers find its shards.
2. **Delegates.** Split by trust boundary or long-running task. Check first whether a platform
   delegate already does the job: [ghostkeys](https://github.com/freenet/ghostkeys) holds
   ghost-key identities and renders its own permission prompt.
3. **UI.** Dioxus if you are in Rust and share logic with contracts, TypeScript + Vite otherwise.
4. **Build, test, publish.** Set up the canonical build, CI and a post-publish liveness test
   before the first release, then test the upgrade path on old state and on an interrupted
   migration, neither of which testing a fresh install exercises.

## When this skill is wrong

If an instruction is wrong or an API has moved, file an issue or PR at
`freenet/freenet-agent-skills`.
