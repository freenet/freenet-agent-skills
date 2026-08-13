# Changelog

All notable changes to this project will be documented in this file.

## 1.19.1 (2026-08-12)

Corrects the delegate-half status again. 1.19.0 replaced "still a documented
stub" with "no production adopters yet" and "sound design, unproven in the
field". That is now wrong too: `freenet-migrate` 0.5.0 is on crates.io and
River, Delta and ghostkeys all drive its delegate-side entry points on `main`
(verified against each repo's `origin/main`, not a local checkout).

- Version references updated from 0.4.0 to 0.5.0 across `SKILL.md`,
  `contract-patterns.md`, `delegate-patterns.md` and `upgrade-and-migration.md`.
  `freenet-migrate-build` stays at 0.2.0, which is still the published latest.
- `delegate-patterns.md`: the "two options, weigh the crate's zero-adopter
  status" framing is replaced with a single recommendation. ghostkeys no longer
  belongs in it as the hand-rolled alternative, because ghostkeys' own sweep now
  drives the crate; its adoption is described as the shape to copy instead.
- Documents `SuccessorSecretsIo`, the load-bearing part of the 0.5.0 breaking
  change. The raw `(key, value)` copy it replaced is wrong for any app whose
  stored items carry cross-entry invariants, and it fails silently.
- The mocked-I/O caveat is kept, since it is still true that the crate has no
  integration test against a real node or a real WASM delegate. The field
  evidence comes from the adopters, both of which gated on a differential test
  against their prior sweep.
- Adds pointers to the `freenet-migrate-adoption` skill from the four places
  that assert "existing apps adopt it without a rewrite". That claim is about
  const shapes and is not a procedure; the procedure lives in that skill.

## 1.19.0 (2026-08-09)

Delegate secret migration docs described the node-level copy-forward as a
work-in-progress stub. It isn't in progress — it was designed, shipped, found
forgeable, and disabled, and after three rejected trust-model designs,
app-level migration is now settled standing policy rather than an interim
measure. The skill previously said "still a documented stub" and "future
work"; both read as "wait for it," which is the wrong guidance for an agent
building a dApp today.

- `delegate-patterns.md`: adds "Delegate secret migration: no core mechanism,
  and why" — the full history (`RegisterDelegateWithPredecessors`,
  freenet-core#4908, shipped then disabled by freenet-core#5199; wire variant
  removed from freenet-stdlib `main` in #91 but **0.9.0 is unreleased**, so
  crates.io is still 0.8.5 and what protects nodes is the call-site disable),
  the three rejected trust-model designs, and concrete guidance.
- Documents that app-level does **not** mean bespoke-per-app:
  `freenet-migrate` 0.4.0 already packages the delegate-side probe
  (`migrate_delegate_secrets`, `register_delegate_with_migration`,
  `PredecessorSecretsIo`) — with the honest caveat that it has no production
  adopters and its ~50 tests all drive mocked I/O, so ghostkeys' hand-rolled
  sweep remains the field-proven shape it codifies. Also names the
  no-user-consent limitation explicitly.
- Resolves an internal contradiction on River's `signing_key:` secret: it is
  never *exported* from the old delegate, but `migrate_signing_key` re-seeds
  the new delegate's copy from `RoomData.self_sk`. Keeps the freenet/river#612
  warning about `self_sk`'s incidental survival.
- `upgrade-and-migration.md` and `contract-patterns.md`: correct the same
  "still a documented stub" / "future work" framing to match.
- `upgrade-and-migration.md`: documents the ecosystem-standard pointer
  contract (freenet-core#5194 record format settled, governance questions
  open; merged via freenet-migrate#9 as a deliberately unpublished in-repo
  crate whose frozen WASM is the deliverable) as an addressing option —
  explicitly flagged as unconsumed scaffolding with no client resolver yet.
- Corrects stale `freenet-migrate` 0.3.0 → 0.4.0 across all four files
  (`freenet-migrate-build` 0.2.0 is still current and unchanged).
- All four touched files now point to
  [freenet-core#2776](https://github.com/freenet/freenet-core/issues/2776) as
  the live-maintained canonical status source, so future drift is a stale
  link to fix rather than restated claims to re-verify.

## 1.18.0 (2026-08-06)

Webapps are upgraded IN PLACE at a permanent URL. The skill said the opposite.

A dApp developer built their own redirect contract to get a stable URL, because
the skill told them every release rotates it. It doesn't. A web container
contract's key is `BLAKE3(container_wasm || publisher_key)`, and the UI is
neither — it is the contract's *state*. Rebuilding a UI cannot move its address.
River has published dozens of releases to one unchanging key this way, and
`fdev website update` is the supported one-command path.

The skill contradicted itself: `delegate-patterns.md` stated the mechanism
correctly, while `facade-pattern.md` opened on the false premise and `SKILL.md`
told every developer shipping more than one release to plan a facade contract
"from day one" — i.e. to hand-build exactly the redirect that isn't needed.

- Adds `references/web-container-contract.md`: how a webapp is addressed, why
  the URL is permanent, `fdev website init/publish/update`, and the operational
  hazards around it — including one that permanently bricks a live site.
  `fdev` versions are unix seconds (~1.78e9), so replacing them with a
  hand-rolled counter seeded below that value makes every future publish fail
  forever, with no recovery. The page now says to keep fdev's versioning unless
  you have a reason not to, and to seed strictly above the current on-network
  version if you switch.
- Documents the `--contract-wasm` pin as a real trade-off rather than a free
  win: it buys a permanently stable address and costs you a frozen container
  implementation that can no longer receive upstream fixes. Also covers where
  the WASM actually comes from (rebuilding it from source yields different
  bytes and silently publishes to a new URL), and that `fdev website list` and
  `init` ignore the pin and will report a different key after an fdev upgrade.
- Covers unrecoverable signing-key loss with real custody guidance (three
  backups, `chmod 600` since `init` doesn't, and the macOS config path, since
  backing up the wrong path looks identical to having a backup), the 50 MiB
  state cap, and rehearsing the first publish against a local node.
- Rewrites `facade-pattern.md` around what it is actually for: moving an
  audience to a *different* contract after a deliberate container-WASM
  migration or key rotation. Not release mechanics.
- Corrects `build-system.md`'s "contract ID reproducibility caveat", which
  blamed ID rotation on the signer's timestamp. That timestamp goes into the
  webapp metadata, which is state; it changes the state at an unchanged ID,
  which is the upgrade mechanism itself.
- Scopes `upgrade-and-migration.md`'s "there is no in-place upgrade" to WASM
  changes, since read flatly it is the sentence that causes this whole mistake.

## 1.17.0 (2026-08-04)

Document where large binary assets (audio, video, images, uploads) belong:
their own contract, not the webapp bundle.

The existing "State Size Budget" guidance already said to shard unbounded
data by write-concurrency unit, but never spelled out the mechanism for the
common case of a UI wanting to serve a media file — an agent following only
"vendor your assets" from the CSP section would reasonably conclude large
files need to ship inside the webapp bundle too, which hits the 50 MiB hard
cap fast and forces re-publishing every asset byte on any unrelated UI
change.

**New section in `ui-patterns.md`**: any contract's non-HTML files are
servable at `/v1/contract/web/{KEY}/{path}`, and that path is same-origin
with the UI's own iframe no matter whose key it names, so a UI can embed
`<audio src="/v1/contract/web/{ASSET_CONTRACT_KEY}/track.mp3">` pointing at
a *different* contract instance without tripping the gateway CSP. Splitting
assets out this way also lets demand-driven hosting retain/evict each asset
independently of the UI contract's own popularity.

## 1.16.0 (2026-08-04)

Make the delegate-reference problem something an agent will actually *find*.

1.15.0 documented it, but only where an agent already reading about delegates
would look. The people most affected have apps that already work and no reason
to open that page.

**A grep, at the top of SKILL.md.** An agent picking up an existing Freenet app
is now told, before anything else, to check whether it hardcodes a platform
delegate's key — with the command to run. That constant goes stale on every
re-key of a delegate the app does not own, including a bare version bump, and
the failure is silent: every request comes back looking like "this user has
nothing stored".

**How to read client-side delegate errors**, which the skill had never covered.
`Missing` means the delegate is not registered — almost always a stale
hardcoded key, and *not* "the user has no data". `ExecutionError` covers rate
limiting and is transient. Includes the caveat that `Missing` is never proof a
user has nothing, since `UnregisterDelegate` leaves secrets behind, and a
version note: up to freenet-core v0.2.119 the websocket layer also emitted
`Missing` when throttling, so on those nodes the two cannot be told apart at
all (fixed in freenet-core#5146).

That overloading is why the August 2026 ghostkeys breakage was hard to
diagnose. The affected app's error handling was correct and still produced a
misleading message, because the protocol gave it nothing to distinguish an app
that needed updating from a user who had never bought a key.

## 1.15.0 (2026-08-04)

Add the consumer side of delegate re-keying, which the skill had never covered.

Everything about delegate migration was written from the **author's**
perspective: your delegate re-keys, so migrate your users' secrets forward. The
other half was missing — **you are a consumer of other people's delegates too**,
and their re-keys break you in a way no migration fixes, because your reference
to them is a build-time constant.

The failure is silent and actively misleading. After a re-key your requests
address an empty namespace, and every response looks exactly like "this user has
nothing stored" — not like an error. No amount of care in your error handling
distinguishes them, because at the protocol level they are identical.

It happened: the ghostkeys delegate was re-keyed twice in one day, every
integration broke, and the first anyone knew was a user reporting their Ghost
Key working in the vault but not elsewhere — the app had told them to go and buy
one they already owned (freenet/ghostkeys#21).

The guidance is to fetch the current key at runtime from something whose address
is stable — a webapp contract's id survives every update of its own state — plus
what to do when that fetch fails (not: fall back to a stored key), and an honest
note that one hardcoded constant remains.

Also states the obligation in the other direction: if you publish a delegate
others depend on, its key is a public API whether or not you intended it.
Publish the current one in the same operation that changes it, gate the publish
on the two agreeing, and never bump a version alone — a bump re-keys the
delegate and breaks every consumer for nothing.

## 1.14.0 (2026-08-04)

Pin the coverage-oriented review agents to Sonnet. They previously carried no
`model:` field, so every one of them inherited Opus from the session — and a
Full-tier review spawns four or five at once.

Measured over the Aug 2-4 window on the uprizer account: subagent sidechains
were 13,007 of 19,615 API calls and roughly 58% of consumption. These agents
read a diff and report `file:line` findings; that is not work that needs Opus.

- `big-picture-reviewer`, `testing-reviewer`, `code-first-reviewer`,
  `codebase-investigator`: `model: sonnet`.
- `skeptical-reviewer` deliberately stays on the session model. It is the
  adversarial bug-hunt lens and the main regression defense, which is the
  thing least worth economizing on.

## 1.13.0 (2026-08-03)

Two additions to the ghost key purchase round trip, both from watching the flow
end to end rather than from reading the API.

**`return_path`.** `return_to` only ever landed a donor on the app's *root*, so
an app that sent them off from a deep-linked view got them back with their
place lost. It now takes a relative route alongside the contract id — a
sub-path, a `#route`, or both — while the vault still synthesises the
`/v1/contract/web/<id>/` prefix itself, so the route only decides what follows
and is refused if it could climb out of the contract.

**Do not gate the action on a cached identity check.** This is the failure that
actually bites in this flow, and it is silent: an app checks `HasIdentity` at
load, renders "buy a ghost key", the user buys one — and the tab they return to
is the one that already checked. There is no callback from the vault, and the
vault opens in a *new* tab, so the original can sit there indefinitely
insisting they have no key.

The fix is not polling or focus listeners; it is not depending on the cached
answer. Use `HasIdentity` to decide what to **offer**, never to decide whether
the user may **attempt**. Let them try, call `SignWithDefault`, and branch on
the result — it prompts if the app holds no grant and returns
`NoIdentityAvailable` only when there is genuinely nothing to sign with. An app
written that way detects nothing, and a stale tab costs one extra click instead
of dead-ending.

## 1.12.0 (2026-08-03)

Bring the ghost key integration guidance in line with the delegate published
today (`ghostkey-common` 0.2.4, live on the network). The old text described an
API that has since changed shape, and developers are reading it now.

**`HasIdentity` is new, and is what most apps want first.** It answers "does
this user have a ghost key at all" *without prompting*, and is deliberately not
permission-filtered — so an app can decide whether to show a buy-a-key button
before asking the user for anything. Nothing could answer that before:
`RequestAnyAccess` always prompts so it cannot be polled, and `ListGhostKeys`
is permission-filtered, so an app holding no grant sees an empty list and
cannot distinguish "the user has none" from "I have not been allowed yet". It
also reports `unusable` — identities whose certificate is present but whose
signing key is gone, which appear healthy in a key list right up until they
fail to sign.

**`SignWithDefault` is now the recommended signing path.** It needs no
fingerprint, and where the app holds no grant the delegate shows a key picker
and replays the request on approval — so the separate `RequestAnyAccess` step
the sketch used to lead with is no longer required. It remains the right call
when you want the fingerprint itself, to display or to store.

**`NoIdentityAvailable` was described wrongly.** The skill said it "means the
user has no ghost key". It means no identity is available *to sign with*:
either the vault is empty, or every identity in it has lost its signing key. It
is specifically *not* returned because the caller lacks permission — that was
the old delegate behaviour, and following it sent users who had already paid
off to buy a second key.

Also documents `GetDefaultKey` returning `None` as "you have no grant" rather
than "the user has no key" (it never prompts, deliberately — an app must not be
able to put a dialog in front of someone by asking a question), and the
`/ghostkey/create/?return_to=<contract id>` round trip so an app can get its
users back after a purchase instead of stranding them in the vault.

The maturity note gains the rough edge worth naming for anyone building a
delegate: a republish moves the delegate key, recovery depends on a committed
registry of previous keys, and both the recovery sweep (freenet/ghostkeys#8)
and build reproducibility (#9) have had real bugs there. Both are closed; the
shape of the risk is permanent.

## 1.11.0 (2026-08-03)

Correct two stale claims that were actively steering readers toward worse
designs. Both were found while designing ghost-key-gated room membership; both
had already been overtaken by shipped freenet-core work.

**`delegate-patterns.md` said delegates cannot run background tasks or touch
contracts.** It listed "create, read and modify contracts", "request user
permission" and "run background tasks" as *planned but not yet fully
implemented* — contradicting this skill's own SKILL.md, which describes
background tasks as a delegate capability. The implemented reality:
`OutboundDelegateMsg` carries `GetContractRequest`, `PutContractRequest`,
`UpdateContractRequest`, `SubscribeContractRequest`, `SendDelegateMessage` and
`RequestUserInput`, each with handlers in freenet-core, and core keeps a
`DELEGATE_SUBSCRIPTIONS` registry that delivers `ContractNotification` to a
subscribed delegate when contract state changes — with no UI open. That is the
long-running background service the doc said did not exist, and the ghostkeys
delegate already ships the permission-prompt path in production. Only
*creating* a delegate from within a delegate remains unimplemented.

Consequence of the error: a reader designing anything that needs verification
too expensive to sit in a contract's validation path would conclude there was
nowhere to put it, and either abandon the design or reach for a centralized
server.

**SKILL.md documented freenet-core#4857 as a live limitation.** That issue —
"State updates permanently lost for rarely-changing fields: silent
ContractQueueFull drop + sender-side neighbor-summary poisoning" — is CLOSED.
The section told readers to expect multi-minute staleness on config, permission
and ban-list fields, and to let important changes "ride alongside a field that
ships frequently". The shipped fix has the queue-full receiver emit a
`ResyncRequest` that clears the sender's poisoned summary, throttled to one per
(contract, peer) per 30s (#4251 showed one-per-dropped-delta amplifies into a
full-state storm; #4862 hardened it against bridge backpressure).

The genuinely useful part of that section — `BTreeMap` never `HashMap` in
summary types, because ciborium serializes `HashMap` nondeterministically and
breaks core's byte-level convergence check — is kept and promoted to its own
heading, since it stands independently of the bug.
## 1.10.5 (2026-08-01)

Warn against unqualified mobile deployment. `SKILL.md` listed the UI's
location as "Web Browser (SPA) or native app" with no caveat, which reads
as license to generate a mobile wrapper on request.

- `SKILL.md`: note under the User Interface component that "native app"
  means desktop — Freenet does not currently support running a full node
  on mobile. Any production mobile wrapper must be clearly flagged as
  experimental, with likely bandwidth/battery/thermal/CPU/background-
  execution problems called out, resource measurements required before
  it's called viable, and no representation as an official Freenet client
  without Freenet Project approval.

## 1.10.4 (2026-08-01)

Publish as an npm package for OpenCode compatibility (originally PR #4). Adds
`package.json` and an `index.js` programmatic API (`listSkills`, `getSkill`,
`readSkill`, `listPlugins`, `getPluginSkills`, etc.) so agents/tools can
consume skills without a Claude Code-specific install path.

The original PR hardcoded the skill list (3 of the then-current 7 skills)
and invented a two-bundle plugin structure that didn't match
`.claude-plugin/marketplace.json`'s actual single `freenet` bundle. Both had
already gone stale by review time. Rewrote `index.js` to discover skills
from the `skills/` directory and plugin bundles from
`.claude-plugin/marketplace.json` at require-time instead of hardcoding
either, so this can't drift out of sync again. Updated README's Available
Skills, OpenCode install, Repository Structure, and Programmatic API
sections to match the current 7-skill lineup.

Review also found: `package.json`'s `files` field omitted `.claude-plugin/`
(so a real npm install would ship without `marketplace.json` and
`listPlugins()`/`getPluginSkills()` would silently return empty — fixed),
and `readReference()` had no path-containment check (fixed). Skill/plugin
maps now use `Object.create(null)` so a `__proto__` lookup returns `null`
instead of `Object.prototype`.

## 1.10.3 (2026-08-01)

Add a strong recommendation to keep contract state small. `dapp-builder`
covered the 50 MiB hard cap (`state-authorization-patterns.md` → "State
Size Budget") but never framed state size as a UX concern — a GET
transfers the entire state before the UI can render, so size is felt
directly as load latency, and WASM execution cost scales with it too.

- `SKILL.md`: new Phase 1 key question — target well under 4 MB per
  contract instance, not just under the 50 MiB cap, and shard by the
  natural unit of write concurrency (per room/user/time-window/shard-key)
  when a kind of data can grow unbounded, rather than letting one
  instance absorb it all.
- `references/state-authorization-patterns.md`: new "Design target: stay
  well under 4 MB per instance" paragraph in the State Size Budget
  section, distinguishing the correctness backstop (50 MiB) from the UX
  design target (4 MB). The existing inbox example (~32 MiB worst case)
  is reframed as a bound the new target argues for revisiting, not one
  that's already settled.

## 1.10.2 (2026-07-30)

Correct the delta requirement added in 1.10.1. That version stated it as a flat
"`get_state_delta` MUST return zero bytes to an up-to-date peer", which is wrong
as a hard rule and would mark a correct live app noncompliant.

Atlas's index contract hand-rolls `get_state_delta` around a plain, non-`Option`
delta struct and serializes it unconditionally, so against its own summary it
returns `IndexDelta { key_auth: None, records: [] }`, about 20 bytes of CBOR
rather than zero (ciborium serializes structs as maps and writes the field
names). Atlas is behaving correctly. It has no all-`None` collapse because it
does not use `freenet-scaffold`; River clears the zero-byte bar only because the
`#[composable]` macro gives it one. A rule that flags Atlas is a false positive
aimed at a real app.

The requirement is now three tiers:

- **MUST NOT** return a delta containing the state, or approaching its size. This
  is the actual defect: freenet/freenet-core#5056 returns 25,403 bytes against a
  24,832-byte state.
- **SHOULD** return a literally empty `StateDelta`. Zero bytes is the only result
  that passes core's converged check.
- **Acceptable**: a few tens of bytes of encoding framing from an all-empty
  struct. Not ideal, not a bug, no penalty.

The discriminator is delta size relative to state size, not an absolute byte
count. Roughly 20 bytes against a 500 KB state versus a state-sized delta is five
orders of magnitude, and no encoding choice moves a contract across that gap.

- `references/contract-patterns.md`: section retitled "The Delta to an Up-to-Date
  Peer" and restated in the three tiers. The all-`None` code block is now framed
  as why you may see a few tens of bytes and why that is tolerable, rather than
  as a defect, and the byte figure is corrected (28 bytes measured for the
  three-field CBOR example, against the 10-15 claimed in 1.10.1, which assumed an
  encoding that does not write field names). Adds the actionable difference for
  an author: `#[composable]` gives you zero bytes for free, a hand-rolled
  `get_state_delta` has to add the collapse itself. Describes core's converged
  test as it actually works, byte-identical summaries first and the
  `get_state_delta` probe only when summary bytes differ
  (`ring/interest.rs`, `broadcast_queue.rs`). The test now asserts the size bound
  that is the real requirement rather than `== 0`.
- `SKILL.md`: same reframing in the *Data Synchronization & Consistency*
  paragraph and Phase 1 step 4.

The companion stdlib change carries the same correction: the "may result in the
contract being deprioritized or removed" consequence is scoped to the MUST NOT
tier only (freenet/freenet-stdlib#90).

## 1.10.1 (2026-07-30)

Document a contract-correctness requirement that was previously undocumented
anywhere: **`get_state_delta(S, summarize_state(S))` must return a literally
empty `StateDelta`, zero bytes.** If a peer's summary matches your state, that
peer already holds everything you have, so there is nothing to send. A contract
that returns anything non-empty there re-ships data the peer already has on
every reconciliation, forever, and the two peers never register as converged.

The trap is that "empty" must mean zero bytes rather than "a struct whose fields
are all empty": a CBOR or bincode encoding of a struct of all-`None` fields is
10-15 bytes on the wire and core cannot tell that from real content. River gets
this right via a mechanism an author may not realise they depend on, the
`freenet-scaffold` `#[composable]` derive collapsing an all-`None` delta struct
to `None`, which the room contract maps to `StateDelta::from(vec![])`. A
contract that hand-rolls `get_state_delta` has no such collapse.

This is currently costing the network real bandwidth: one live contract never
reads the summary argument and returns its whole state as its delta, and is
55.6% of all broadcast sends on Freenet (freenet/freenet-core#5056). Core is
adding a probe that will flag violating contracts, so the guidance needs to
exist before the enforcement does.

- `references/contract-patterns.md`: new "The Delta to an Up-to-Date Peer Must
  Be Zero Bytes" section next to the commutative monoid requirement, showing the
  wrong shape (serializing an all-`None` struct) beside the right one, the
  `freenet-scaffold` collapse that River relies on, and a test pinning both the
  zero-byte self-delta and the summary-much-smaller-than-state signal. The
  `ContractInterface` trait listing now carries the requirement inline on
  `get_state_delta` and `summarize_state`, matching the existing
  "MUST be commutative" convention on `update_state`.
- `SKILL.md`: states the requirement where Summaries and Deltas are introduced
  under "Data Synchronization & Consistency", and folds it into Phase 1
  implementation step 4 alongside the commutative monoid requirement.

## 1.10.0 (2026-07-29)

Cover a topic `dapp-builder` had nothing on: how a dApp decides there is a real
person behind a key. Any contract that accepts writes from strangers eventually
needs this, and the skill previously said nothing about it, so an agent building
one would either invent a proof-of-work scheme or ship no gate at all. Adds
[ghost keys](https://github.com/freenet/ghostkeys) as the recommended
alternative, with an explicit conflict-of-interest disclosure.

- `references/identity-and-addressing.md`: new "Cryptographic CAPTCHA: is a real
  person behind this key?" section. Frames the problem as a CAPTCHA replacement
  rather than narrow sybil resistance, since that is the range of things ghost
  keys cover (signup, posting, joining, voting, rate limits). Covers
  proof-of-work honestly — where it wins (zero friction, no payment, no prior
  setup) and its four weaknesses, the load-bearing ones being that GPU-vs-phone
  asymmetry runs backwards and that its cost is *burned* as waste heat rather
  than transferred. Covers ghost keys: blind-signed (RFC 9474) certificate
  proving an anonymous donation, so cost is monetary and cannot be beaten with
  hardware, is graduated by amount and date rather than pass/fail, is paid once
  per user rather than once per app, and verifies offline. Includes an
  integration sketch against `ghostkey-common` 0.2.3, the `NoIdentityAvailable`
  / `AccessDenied` UI states, a note that verifying a certificate per member on
  every `validate_state` load scales badly, a "where ghost keys do not fit"
  section, and a maturity caveat with recourse (file at `freenet/ghostkeys`;
  issues blocking app developers are prioritized).
- Same file: **"Recommended: proof-of-work with a ghost key escape hatch"**, which
  is the section's actual recommendation. The two mechanisms compose better than
  they compete: run proof-of-work as the always-sufficient default so nobody is
  ever excluded, and offer a ghost key as a way to *skip the wait*, surfaced
  while the grind is running and the user is blocked with nothing to do. That
  cancels each mechanism's worst property — difficulty can be set by what deters
  an attacker rather than by what the slowest device tolerates, the attacker
  faces both a money wall and a compute wall, and payment plus the centralized
  mint become an accelerator rather than a gate. Includes an `AdmissionProof`
  enum accepting either proof against the same challenge, and three guardrails:
  keep the free path genuinely completable, never slow the grind to drive
  conversions (named as the dark pattern it would be, given the disclosed
  funding interest), and do not grant ghost keys privileges users actually need
  or the paywall is rebuilt.
- Same file: a **"The centralized mint"** section. Ghost keys are anonymous but
  centrally issued, which is a real cost on a platform built to remove central
  points of trust. States precisely what that costs (issuance is a single point
  of failure, there is a trust root to compromise, the payment rail can
  decline or geo-block) and what it does not (verification stays offline, so
  existing keys survive the mint disappearing; blind signing means it is not a
  privacy centralization). Links Freenet's own "Why donations?" rationale and
  Proof of Trust as the decentralized alternative being explored, then says
  plainly that choosing proof-of-work over it is coherent rather than stubborn.
  Proof-of-work's "no issuer, no trust root" advantage added to its own section
  as the counterpart.
- Same file: a **disclosure** section stating that Freenet is funded by the
  donations that mint ghost keys, separating the parts of the argument that are
  independent of who receives the money (hardware-proof cost, blind signing,
  transferred-not-burned) from the part that is not (that the recipient is
  Freenet), and instructing agents to surface the tradeoff to the developer
  rather than wiring ghost keys in silently. Kept distinct from the
  centralization section on the grounds that an incentive disclosure and an
  architectural limitation are different objections and neither answers the
  other. Plus a new checklist item.
- `SKILL.md`: new Phase 1 key question ("can strangers write to this contract?")
  pointing at the section and carrying the same present-the-choice instruction;
  new Phase 2 key question on borrowing an existing platform delegate rather
  than building one, with ghostkeys as the example; expanded description of
  `identity-and-addressing.md` in the Phase 1 reference list.

## 1.9.1 (2026-07-29)

Recommend browser automation for validating a `dapp-builder` UI *while building
it*, not only at release time. Playwright was already covered in Phase 4 (the
post-publish `production-liveness.spec.ts`) and listed as the `offline` tier in
the test-tier table, but Phase 3 (UI Design), where the UI is actually written,
said nothing about validating it in a browser and the `offline` tier had no
recipe anywhere. A Dioxus UI ships as a WASM bundle whose real render path only
runs in a browser, so without browser automation a UI has no automated coverage
at all until after publish.

- `SKILL.md` Phase 3: new "Validate the UI in a real browser (both options)"
  subsection covering Dioxus and TypeScript alike. Drive the UI with Playwright
  from the first screen onward; gate PRs on the dev-server (`offline`) tier;
  assert a clean browser console, since WASM panics and CSP blocks surface only
  as console or network errors; re-run the same flows against the gateway-served
  webapp (`iso` tier), which needs `frameLocator` and an absolute-URL `goto`.
  Points at the Playwright MCP browser tools (`local-dev` skill) for interactive
  debugging, and expands the Phase 3 reference list to include
  `production-smoke-testing.md`.
- `references/production-smoke-testing.md`: new "Validating the UI during
  development (the `offline` tier)" section with a starter `ui-smoke.spec.ts`
  (mount assertion plus one real interaction plus console-error gate) and the two
  WASM-specific gotchas: wait on rendered content rather than `page.goto`
  resolving, and make sure the run is testing the current build rather than a
  stale `dx serve` bundle.

## 1.9.0 (2026-07-21)

Update the `dapp-builder` upgrade/migration guidance to match the now-shipped,
field-deployed reality of `freenet-migrate`. The v1.6.0/v1.7.0 corrections fixed
the framing and v1.8.0 fixed discoverability while the crate was still v0.1.0 and
aspirational ("prefer over hand-rolling"); it is now **`freenet-migrate` 0.3.0 /
`freenet-migrate-build` 0.2.0 on crates.io** and is the mechanism River's
contract-migration path runs in production. Corrections to match shipped source,
not new speculation. Ground truth verified 2026-07-21: crate versions on
crates.io; River's adoption PRs freenet/river#434 (build codegen), #436 (UI
decision-driver), and #437 (riverctl decision-driver) all merged; riverctl 0.1.80
/ river-core 0.1.16 on crates.io. Refs freenet-core#2776.

- Crate **version + status** across `SKILL.md`, `contract-patterns.md`,
  `delegate-patterns.md`, and `upgrade-and-migration.md`: `freenet-migrate` is now
  **0.3.0** (with `freenet-migrate-build` **0.2.0**), no longer "published as
  v0.1.0". Reframed from the "prefer over hand-rolling" aspiration to the shipped,
  reviewed, field-deployed mechanism River's contract-migration path runs live
  (browser UI + `riverctl`).
- **Existing apps adopt it without a rewrite** (`contract-patterns.md`,
  `delegate-patterns.md`, and the SKILL.md / upgrade bullets):
  `freenet-migrate-build` reads the River-style `[[entry]]` registries
  (`entry_registry`) and emits byte-array *view* consts matching hand-rolled const
  shapes (`contract_hash_view`, `delegate_pair_view`); views-only mode
  (`canonical_consts(false)`) needs no runtime dependency; registries accept hex or
  base58; every build re-derives `delegate_key == blake3(code_hash || params)`
  (`irregular_key = true` for grandfathered pre-standard keys). Worked example:
  freenet/river#434.
- **Sans-IO decision driver** (`contract-patterns.md`, SKILL.md upgrade bullet):
  documented the 0.3.0 `ProbeDriver` (newest-first by the generation field,
  first-real-hit wins, timeout/undecodable advances, single-shot late responses,
  hop cap, exhaustion seeds the local snapshot) with the app pumping I/O and
  supplying `ProbeStateOps` (`decode` / `is_real` / merges / `prepare_forward`, the
  #427 pointer-strip seam), plus `SelectionPolicy::NewestFirstWins` (default) vs
  `FoldAll` (tombstoned states with a commutative + idempotent merge, ack-gated).
  Worked examples: freenet/river#436 (UI event-driven pump), #437 (riverctl
  synchronous recovery).
- **Delegate path kept honest, not overstated** (`delegate-patterns.md`, SKILL.md
  delegate bullet, `upgrade-and-migration.md`): the node-mediated transport into a
  predecessor *delegate* is still a documented stub, so delegate secret migration
  still runs the River/Delta app-side re-run-old-WASM way; delegate-side entry
  points and a node copy-forward primitive remain future work (freenet-core#2776).
  The crate's field-deployed carry-forward today is the *contract* path only.

## 1.8.1 (2026-07-18)

Warn `dapp-builder` users about a current-core state-propagation limitation that
dApp contract designers must design around, and give them the cheap mitigations.
In current Freenet core, an UPDATE to a rarely-changing field (config, metadata,
an authority/permission field, a ban list) can be silently lost between two peers
and stay missing until the slow (~5 min) anti-entropy heal catches up, which can
itself drop again under load. Fields that change often self-mask the bug; rarely
changing ones do not. Tracked and being fixed in core: freenet/freenet-core#4857.

- `SKILL.md` Data Synchronization & Consistency: added a "Known limitation: a
  rarely-changing field can lag between peers" subsection. Developer-facing
  description of the symptom plus three mitigations: (1) use `BTreeMap` never
  `HashMap` in your `Summary` type (a `HashMap` serializes in nondeterministic
  order, breaking core's byte-level summary comparison, the single cheapest fix);
  (2) do not assume a one-shot change to a rarely-updated field propagates
  instantly, make sure state genuinely converges via `summarize`/`delta`/`apply`
  and test it; (3) when debugging "some peers do not see my update," suspect this
  core limitation before your own `apply` logic.
- `references/contract-patterns.md` Common Commutativity Bugs: added a
  code-adjacent note that `Summary` types must serialize deterministically
  (`BTreeMap`, not `HashMap`), cross-referencing the SKILL.md limitation.

## 1.8.0 (2026-07-12)

Make the `dapp-builder` **upgrade** knowledge discoverable and consolidated, so a
future agent (or dev) prompted "upgrade my Freenet dApp" / "bump stdlib" / "ship
contract v2" lands on ONE clear, complete playbook and does not fall into the
"recreate everything / dead invites" trap. The v1.6.0/v1.7.0 corrections fixed the
*framing*; this release fixes *discoverability + completeness*. Grounded in River's
live 0.6→0.8 stdlib re-key (verified 2026-07-12): rooms auto-migrated on refresh,
invites survived, the 78-member Official room stayed intact, no recreation.
Refs freenet-core#2776.

- `SKILL.md` frontmatter **description**: added upgrade/migration to the routing
  triggers ("upgrade an existing dApp — bump freenet-stdlib, ship a new
  contract/delegate version (v2), fix a bug that re-keys the WASM, or migrate state
  across a key change without breaking invites or losing data"). The skill had deep
  upgrade content but the description advertised only *new*-dApp use cases, so an
  agent asked to upgrade might not be routed here.
- `SKILL.md` Development Workflow: added a prominent "Already shipped v1 and here to
  UPGRADE?" signpost routing straight to the consolidated playbook, so the upgrade
  path is not buried across Phase 1 / Phase 2 / Phase 4 steps.
- `upgrade-and-migration.md`: added the consolidated **"Upgrading a Freenet dApp —
  the painless path"** playbook as the discoverable hub — six numbered steps tying
  together the v1 design precondition (choose a **stable identity anchor
  independent of the WASM** — never expose the raw contract key as identity; the
  anchor options are owner/user key [e.g. River], a fixed namespace/singleton
  params, a DID, or an index contract — this is general, NOT owner-key-only),
  reproducible builds (commit lockfile, pin toolchain), register
  the outgoing code hash BEFORE changing the WASM (`cargo make add-migration` /
  `add-room-contract-migration`), the `freenet-migrate` crate (crates.io v0.1.0)
  for the carry-forward, publish + per-client auto-migrate on next load, and the
  explicit "do NOT recreate instances / rotate keys / warn of dead invites"
  (recreation is only for a deliberate owner-identity change). Honest caveats kept:
  self-authorizing + backward-compatible state OR a written carry-forward;
  per-client on next load; a fresh device has no local state. The existing
  deep-dives (contract/delegate patterns, five-properties discipline, test harness)
  remain as references the playbook links to — no duplication.

## 1.7.0 (2026-07-12)

Reframe the `dapp-builder` contract/delegate **upgrade** guidance so third-party
developers learn the correct headline: a routine WASM/stdlib bump is **low-risk
and mechanical when you design for it**, not "recreate everything and all invites
die". Grounded in River's real 0.6→0.8 re-key + republish on the live network
(verified 2026-07-12). Corrections, not new speculation. Refs freenet-core#2776.

- `SKILL.md` (Phase 1, step 6): lead with the low-risk/mechanical outcome and
  state the key property explicitly — when identity is anchored on a stable
  owner/user key (not the contract key), **owner-key-derived references survive a
  re-key** (invites, share links, membership, external services keep working
  because the client re-derives the new contract key from the unchanged owner
  key), state auto-migrates on next load, and the one required step is
  registering the outgoing code hash before republishing. Recreation is only for
  deliberately changing the *owner* identity.
- `contract-patterns.md` ("Contract WASM Upgrade & State Migration"): added a
  "what this buys you" paragraph making the invites/references-survive property
  prominent, framed honestly as a consequence of designing for it (key-derived
  identity + legacy registry + self-authorizing, backward-compatible state) with
  the caveats kept (per-client on next load; fresh device has no local state to
  migrate). Grounded in River's `Invitation` embedding the room owner's verifying
  key rather than the room contract key.
- Corrected the now-stale **`freenet-migrate` publish status** across
  `contract-patterns.md`, `delegate-patterns.md`, and `upgrade-and-migration.md`:
  the crate (and `freenet-migrate-build`) is **published on crates.io as v0.1.0**,
  not "not yet published / once it lands". Kept the honest v0.1.0 caveat (targets
  stdlib 0.8.x; the node-mediated predecessor-*delegate* transport is a documented
  stub, so delegate migration still runs the River/Delta re-run-the-old-WASM way).

## 1.6.0 (2026-07-10)

Correct the `dapp-builder` contract/delegate **upgrade & migration** advice to
match how River and Delta actually work (verified against source), and add
byte-reproducibility as a first-class best-practice. Corrections, not new
speculation. Refs freenet-core#2776.

- `delegate-patterns.md`: removed the fictional `ExportSecrets` handler. River's
  real mechanism is a backward probe that messages each old delegate key via
  `DelegateRequest::ApplicationMessages`, **re-running the old WASM** to read its
  secrets; per-room signing keys are carried forward and encryption secrets are
  re-derived. Documented that this re-run is **fragile** — it breaks after a
  freenet-stdlib/ABI bump makes the frozen old WASM un-runnable (River V4–V6 lost
  data this way, freenet/river#204). Kept the `legacy_delegates.toml` + `build.rs`
  registry; added the key-derived-identity precondition.
- `contract-patterns.md`: re-framed the **backward-probe from a committed
  legacy-code-hash registry** (River #292, Delta) as the shipped baseline, and
  the author-signed `OptionalUpgrade` pointer as an optional straggler layer that
  no app drives migration off of (re-labeled, not deleted). Stated the
  preconditions as hard requirements (mergeable/commutative state, strict
  self-authorizing `validate_state`, backwards-compatible format, key-derived
  identity, release-signing key for the pointer path).
- `build-system.md`: added "the lockfile is necessary but NOT sufficient" —
  commit `Cargo.lock` (River's was gitignored, freenet/river#393) + pin the
  toolchain + build `--locked`, plus the caveats the lockfile misses
  (`wasm-opt`/binaryen version, the `dx` UI-toolchain version, absolute
  build-path embedding → `-Ctrim-paths`) and the build-command footgun (a
  contract built alone vs co-built unifies features and yields different bytes —
  always use the canonical build script).
- `SKILL.md`, `upgrade-and-migration.md`: aligned the phase steps and reference
  bullets with the above; pointed at the reusable `freenet/freenet-migrate` crate
  (recommended direction, not yet on crates.io — prefer it over hand-rolling once
  it lands).

## 1.5.2 (2026-06-21)

Finish absorbing the freenet-email v0.1.x publish/debug lessons (issue #23).
Patterns 1, 3, and 4 from that issue landed earlier (PRs #34/#35/#36); this
fills the two remaining "pattern 2" gaps:

- `local-dev`: documented the `WS_API_PORT` environment variable for
  targeting a non-default node when publishing through a `cargo-make`
  `publish-*` task (which has no `--port` flag). Notes the unhelpful
  `put failed after 4 attempts` failure mode of a misdirected cargo-make
  publish.
- `dapp-builder` (`references/production-smoke-testing.md`): documented the
  wasm-bindgen `onerror` shim crash (`imported JS function that was not
  marked as 'catch' threw an error: expected a string argument, found
  undefined`) as known-benign console noise from the gateway WebSocket
  bridge. Explains why the smoke test gates on a curated
  `FATAL_CONSOLE_PATTERNS` allowlist instead of asserting
  `consoleErrors === []`, and to leave this message out of the fatal list.

## 1.5.1 (2026-06-09)

- `pr-review`: Step 3 now specifies a fallback when external models are
  unavailable. If `codex` fails, try `gemini`; if both are down (quota /
  capacity / outage), the review no longer fails — it substitutes a
  diverse-Claude-lens pass (at least three independent adversarial lenses,
  per `~/.claude/rules/multi-model-review.md`) and records the substitution
  in the posted review. Previously the skill described only the external pass
  with no documented behavior when it could not run. Also: prefer waiting for
  the external model when the change isn't time-sensitive and the quota reset
  is near, and run the lenses serially within your own context when you can't
  spawn subagents (background / dispatched agents without the Agent/Task tool).

## 1.5.0 (2026-06-05)

- `dapp-builder`: added `references/upgrade-and-migration.md` — the operational
  discipline for upgrading contracts and delegates without losing user data,
  distilled from River's production incidents (freenet/river#345 per-entity CAS
  keys, #352 resumable/interrupted-migration recovery, #253 regression-gated
  legacy probe). Covers the five properties of a safe migration (idempotent,
  resumable, non-destructive, regression-gated, observable), sharding mutable
  storage by unit-of-concurrent-change with compare-and-swap instead of blind
  overwrite, enumerating dynamic key families, coupled-artifact lockstep, the
  upgrade test harness (old-state -> new-code plus interrupted-migration
  recovery), and staged reversible rollout. Linked from SKILL.md Phase 1/2
  migration steps and Phase 4.

## 1.3.0 (2026-05-28)

Sync Freenet-specific dApp practices proven out in freenet/mail through
May 2026 (issues #198, #199, #200, #206, #213, #251). Generic engineering
practices (CI runner sizing, version-drift guards, pre-commit hooks, QA
matrices, upstream-bug quarantine) deliberately left out of this version
— they belong in a separate non-Freenet skill set.

- `local-dev`: documented the **isolated multi-node harness pattern** —
  `--config-dir` per node (NOT `--data-dir`) is what isolates
  `config.toml` and transport keypairs across two `freenet` instances on
  one host. On CI runners with `XDG_CONFIG_HOME` set, a `HOME=…`
  override is bypassed and only `--config-dir` works.
- `dapp-builder/build-system.md`: documented **per-contract lockfile
  isolation** (`[workspace.exclude]` + own `Cargo.lock` + `=x.y.z` pins
  + `CARGO_TARGET_DIR=<crate>/target` on every `fdev build`). Without
  this pattern, a workspace dep bump silently rotates contract WASM
  bytes and IDs, orphaning every user's stored state. Also documents
  the **contract-ID reproducibility caveat**: signed-payload version is
  a unix timestamp at signing time → contract IDs are NOT reproducible
  from source, the committed `contract-id.txt` / `facade-id.txt` are
  authoritative.
- `dapp-builder/references/contract-patterns.md`: documented the
  **chained-migration recipe** — append-only `LEGACY_*_CODE_HASHES`
  walked oldest→newest on UI startup when an identity's recorded WASM
  hash drifts from current; `pending_migration_from` on the delegate
  for cross-session retry; recipient WASM hash captured at contact
  import so upgraded senders can deliver to non-upgraded recipients;
  the `current_hash_not_in_legacy` test invariant.
- `local-dev`: documented installing `fdev` / `freenet` from the
  freenet-core release tag's prebuilt `.tar.gz` rather than
  `cargo install` — same binary CI uses, ~5s vs 10–15 min, and pins
  you to a known fdev API surface (matters for the `--as-state` flag
  used by facade pointer flips).
- `dapp-builder/build-system.md`: documented the **pre-commit hook for
  signed-and-committed publishing** — block stray `.wasm` outside
  `published-contract/`, require `contract-id.txt` co-staged alongside
  any WASM change. Without it, build artifacts leak into commits and
  snapshot drift goes unnoticed.
- `dapp-builder/references/production-smoke-testing.md`: documented the
  **four Freenet dApp test tiers** (offline / iso / liveness / rust),
  what each catches and what each misses, so a project doesn't ship
  thinking a liveness smoke covers real round-trip behavior.
- `systematic-debugging`: documented **structured-field log assertions**
  in E2E — modern freenet-core (0.2.6x) emits tracing fields like
  `phase="update_complete"` and `phase="relay_started"`. Asserting on
  legacy wire-level markers (`UPDATE_PROPAGATION`) gives silent false
  positives. Also: quarantine upstream bugs with `skip-with-reason`,
  do not remove the test.
- **NEW** `dapp-builder/references/facade-pattern.md`: full **stable-URL
  facade contract architecture** — facade WASM (never rebuilt per
  release) + facade-types crate + `FacadePointer { version,
  current_app_id, prev_app_ids }` state + `fdev execute update
  --as-state` (default `UpdateData::Delta` is silently rejected) +
  `postMessage`-to-parent loader (gateway's `X-Frame-Options: DENY`
  blocks same-window redirects from inside the sandbox iframe) +
  webapp-cache busting after pointer flips + CI byte-equality check
  with non-linux/amd64 bootstrap flow.

## 1.2.3 (2026-05-26)
- `dapp-builder`: documented the gateway CSP, iframe shell, and post-publish
  smoke testing — three "only show up in production" pitfalls every Freenet
  webapp hits (issue #22, distilled from freenet/mail v0.1.0).
  - **Vendor your assets.** New "Gateway CSP: Vendor Your Assets" section in
    `ui-patterns.md` explains the same-origin CSP (both `default-src` and
    `connect-src`), why CDN `<link>` / `<script>` tags and cross-origin
    `fetch` calls work in `dx serve` / `vite dev` but fail under
    `fdev publish`, and the right way to bundle stylesheets / fonts under
    `ui/assets/vendor/` (Dioxus `asset_dir` convention, matching River).
    Cross-linked from SKILL.md Phase 3.
  - **Iframe shell + Playwright recipe.** New
    `references/production-smoke-testing.md` documents the
    `<iframe id="app">` shell architecture (with a "source of truth"
    pointer to `freenet-core/crates/core/src/server/{client_api,path_handlers}.rs`)
    and the two Playwright idioms it breaks (`page.locator(...)` finds
    only the shell; `page.goto("/")` lands on the dashboard). Includes a
    `production-liveness.spec.ts` template that:
    - waits for the shell bridge to assign `iframe#app[src]`,
    - asserts the bundled `<h1>` mounts inside the iframe,
    - asserts vendored CSS loaded via `getComputedStyle(...).fontWeight`
      (more stable than `fontSize`, matching the proven
      freenet/mail#28 assertion),
    - filters console errors via `FATAL_CONSOLE_PATTERNS` (CSP /
      `Refused to ...` / `net::ERR_`) so benign warnings don't flake.
    Also includes a `playwright.config.ts` snippet and a CI bash sketch
    that boots a local node, publishes, and exports `FREENET_BASE_URL`.
    Cross-linked from SKILL.md Phase 4 and from `ui-patterns.md`'s "Two
    Connection Models" section.
  - **Tooling preflight.** New section in `build-system.md` noting that
    the gateway port is `7509` (older docs reference the legacy `50509`)
    and offering optional `gnu-tar --sort=name --mtime=@0 --owner=0
    --group=0 --numeric-owner` flags for byte-reproducible webapp archives
    across macOS/Linux build hosts (recommended, not required —
    `fdev publish` itself uses the Rust `tar` crate).

## 1.2.2 (2026-05-26)
- `local-dev` skill: document two silent isolation gotchas that bit users
  during freenet-email E2E debugging (issue #24).
  - **`--data-dir` does not isolate the gateway bootstrap list.** `freenet`
    reads `gateways.toml` from the global config dir (`~/Library/Application
    Support/The-Freenet-Project-Inc.Freenet/` on macOS, `~/.config/freenet/`
    on Linux) regardless of `--data-dir`. On a machine with an existing
    Freenet install, a "local" test node silently dials public gateways and
    joins the live network. New subsection documents the `HOME` override
    workaround and a log-grep verification step.
  - **`fdev` defaults to port 7509.** Without `--port`, `fdev publish`
    silently targets whichever node owns 7509 — typically the system
    service, not the test node. Surface symptom: `"Signature verification
    failed"` on a fresh publish. New callout warns about this and the
    common-issues table now lists both new symptoms.
  - Replaces the misleading "Each node is fully isolated" claim with a
    pointer to the new pitfalls section.

## 1.2.1 (2026-05-25)
- `release` skill rewritten to use `gh workflow run release.yml --field
  version=X.Y.Z` instead of the legacy `./scripts/release.sh` invocation.
  AGENTS.md in freenet-core already documented the workflow as the canonical
  path; the skill had drifted out of date and was telling agents to run the
  script locally (which bails on the "must be on main" branch check from any
  worktree). New flow: trigger workflow → `gh run watch` → verify cascade
  (gateway-update.yml + release-announce.yml fire on `release.published`) →
  River smoke test → post-release health check. Net effect: skill shrunk
  from 312 to ~145 lines and now matches what the pipeline actually does.

## 1.4.0 (2026-05-28)

Stacked on top of 1.3.0 (mail-practices sync). Aligns `dapp-builder` +
`local-dev` with freenet-stdlib v0.8.0 (Rust) and
`@freenetorg/freenet-stdlib` v0.2.0 (TypeScript). Pre-existing 0.6.0
pins were two releases behind; this catches up and documents the deltas
in between. Bumped the inbox-contract lockfile-isolation example added
in 1.3.0 from `=0.6.0` to `=0.8.0` to match.
- `dapp-builder/SKILL.md`:
  - Added **TypeScript + Vite** as a first-class UI option (Phase 3 / Option B) alongside Dioxus, including a parallel project structure template and an npm/Vite dependency table.
  - Bumped Rust `freenet-stdlib` pins from `"0.6.0"` to `"0.8"` (workspace + UI crate); added TypeScript pin `"@freenetorg/freenet-stdlib": "^0.2.0"`.
  - Added security note about stdlib v0.6.0 removal of public `DEFAULT_CIPHER`/`DEFAULT_NONCE` constants (PR #75) — delegates must now generate random cipher/nonce per session.
- `dapp-builder/references/ui-patterns.md`:
  - New TypeScript + Vite section covering the FlatBuffers serialization model, contract/delegate hash injection at build time, and the dynamic-import pattern for internal `-T` types.
  - Bumped Cargo.toml stdlib pin to `"0.8"`.
  - Completed the `ResponseHandler` example with v0.2.0 callbacks `onContractNotFound`, `onSubscribeResponse`, `onClose`.
  - Converted `api.get/put/update/subscribe` examples to the **promise-based API** (`await api.X(...)` + try/catch). Noted that callbacks still fire alongside promises for backward compatibility and that the default request timeout is 30 s.
  - New section "Large state handling (streaming)" covers `CHUNK_THRESHOLD = 512 KB`, `CHUNK_SIZE = 256 KB`, `ReassemblyBuffer`, and the v0.2.0 concurrency limits.
  - Added warning above the `(api as any).sendRequest(...)` cast — internal SDK method, may break on any minor SDK bump; track stdlib for a public delegate-message builder.
- `dapp-builder/references/delegate-patterns.md`:
  - Renamed `attested: Option<&'static [u8]>` parameter to `origin: Option<MessageOrigin>` in `DelegateInterface::process()` examples (stdlib v0.5 breaking change).
  - New section "Inter-delegate messaging" covering `MessageOrigin::WebApp(ContractInstanceId)` vs `MessageOrigin::Delegate(DelegateKey)` (PR #65), with a whitelist-based authorization pattern and the note that an inter-delegate message replaces (not composes with) any inherited `WebApp` origin.
  - Added wildcard `_ => {}` arms to all `InboundDelegateMsg` matches with comments noting the `#[non_exhaustive]` requirement from stdlib v0.6.0 (PR #66).
  - Added API drift note flagging that the pre-v0.5 secrets-by-message pattern is now `DelegateCtx::get_secret/set_secret` synchronously.
- `dapp-builder/references/build-system.md`:
  - Added TypeScript + Vite plain-`Makefile` block alongside the Rust + cargo-make flow; documented that River uses cargo-make and freenet-microblogging uses plain Make + Vite.
  - **`fdev publish` differs for contracts vs delegates.** Contracts take raw `target/wasm32-unknown-unknown/release/*.wasm`; delegates take the packaged file from `build/freenet/` produced by `fdev build --package-type delegate`. Wrong file type → silent failure or cryptic errors.
  - Documented the ANSI-strip pattern when piping `fdev` output (`sed 's/\x1b\[[0-9;]*m//g'`) and the `clean-node` pattern for republishing under the same key during dev.
  - Bumped Rust workspace stdlib pin from `"0.6.0"` to `"0.8"`; bumped the inbox-contract lockfile-isolation example added in 1.3.0 to `=0.8.0` to match.
- `local-dev/SKILL.md`:
  - Renamed "seeding contracts" → "hosting contracts" in `NodeDiagnosticsConfig` comment to match the stdlib terminology rename (PR #64).
  - Added wire-format note: `NodeDiagnosticsResponse.contract_states` is now `HashMap<String, ContractState>` with Base58-encoded keys (PR #70, v0.7.0 bidirectional bincode break).

## 1.2.0 (2026-05-21)
- Added `dapp-builder` reference `identity-and-addressing.md`: how to give users a
  short, stable, shareable identifier without leaking raw key material or coupling
  identity to a contract's WASM version.
  - **Self-certifying short identifiers.** Make the user-facing "address" a short
    hash of the public key; keep the full key in contract state (not parameters)
    and have `validate_state` verify the key hashes to the address.
  - **Crypto key sizing.** Elliptic-curve keys are 32 bytes; post-quantum public
    keys (ML-DSA, ML-KEM) run to kilobytes and need a separate key per operation —
    keep large key material out of identifiers and parameters.
  - **Address truncation is a security parameter.** Guidance on choosing the hash
    truncation length for second-preimage resistance (16 bytes / 128-bit default).
  - **Identity must not be a contract key.** A user's stable handle has to be
    key-derived so it survives WASM upgrades; migration moves state across
    contract keys while the address stays fixed.
- `contract-patterns.md`: "Contract Parameters" now warns against embedding large
  keys in parameters; the migration section notes identity must be key-derived.
  Cross-references added from `SKILL.md` Phase 1 and the skill README.

## 1.1.0 (2026-05-20)
- Reworked `pr-review` to match current Claude Code capabilities and PR-review
  best practices:
  - **Risk-tiered review.** The skill triages each PR to Skip / Light / Full and
    scales the reviewer set to match — trivial changes are not put through the full
    multi-model treatment; high-risk surfaces (concurrency, crypto, migrations, wire
    format, transport, contract/delegate WASM) always get the full review.
  - **Parallel subagents are now the default path**, not an optional addendum.
    The skill orchestrates the four reviewers concurrently rather than walking
    one agent through six perspectives by hand.
  - **Invokes the reviewers as first-class subagents** (`freenet:code-first-reviewer`,
    `freenet:testing-reviewer`, `freenet:skeptical-reviewer`,
    `freenet:big-picture-reviewer`) via the `Agent` tool's `subagent_type` with
    `run_in_background: true`. Removed the obsolete "spawn `general-purpose` and
    paste the agent definition into the prompt" instructions.
  - **Reviews from a dedicated worktree** of the PR's code, so reviewers `Read`/`Grep`
    the PR's actual code (not `main`'s) without disturbing the user's working tree —
    avoids `gh pr checkout` clobbering uncommitted work. Added checkout-awareness
    notes to all four agent definitions.
  - **Fetches existing PR review comments** up front (issue-level and inline) so
    the review addresses prior feedback instead of duplicating it.
  - **Added a synthesis step**: deduplicate overlapping findings, reconcile
    reviewer disagreements, and verify every cited `file:line` before reporting.
  - **Posts the consolidated review to the PR** via `gh pr review --comment`.
  - Replaced the vague "ask Codex" instruction with a concrete external-model pass
    (`codex review`), optionally wrapped by a `codex-review` / `gemini-cli-review`
    skill when the environment provides one.
  - De-staled the Freenet bug-pattern guidance: SKILL.md and the skeptical/testing
    agents now point at the canonical, continuously-updated
    `.claude/rules/bug-prevention-patterns.md` in freenet-core and no longer claim
    the frozen Feb-2025 snapshot of five patterns is complete.
  - Added large-diff (file-batching) guidance and a mandatory worktree-cleanup step.

## 1.0.19 (2026-05-06)
- Reordered concepts in `dapp-builder/SKILL.md`: the "Core Concept: The
  Contract is the Key" section used to come before the components were
  introduced, so it forward-referenced "the WASM that controls the data"
  and the table-row analogy. Moved the key-derivation explanation below
  "The Three Kinds of Components" and renamed it "How Contract Keys Work
  (and Why Freenet is Trustless)" so the reader knows what a contract is
  before reading how its key is formed. Trimmed the contracts-section
  bullet to defer the addressing mechanism to the new section.

## 1.0.18 (2026-05-06)
- Clarified `dapp-builder/SKILL.md` to make explicit that a Freenet app can
  have multiple contracts and multiple delegates (the previous "The Contract"
  / "The Delegate" framing implied exactly one of each). Reframed the
  contract analogy from "Backend or Database" to a database **table**: the
  WASM is the schema, and each parametrized instance is a row with its own
  key and state. Updated Phase 1 / Phase 2 wording and the project-structure
  template to reflect the per-concern split.

## 1.0.17 (2026-05-06)
- Fixed install instructions in `README.md` and `skills/dapp-builder/README.md`:
  the marketplace exposes a single bundled plugin named `freenet`, but the
  READMEs told users to run `/plugin install freenet-dapp-builder` and
  `/plugin install freenet-core-dev` (neither exists). Replaced with the
  correct `/plugin install freenet@freenet-agent-skills` form.

## 1.0.16 (2026-04-29)
- Fixed release skill: documented the new tiered merge_group model
  (freenet/freenet-core#3973). Release merge_group entries now run the FULL
  suite (Unit & Integration, Simulation, NAT Validation) as the pre-publish
  gate. Non-release merge_group entries skip Simulation and NAT Validation
  (covered by PR-level CI). Updated wait timings: 60 min PR-merge wait, ~20-30
  min for the release gate. Replaced the obsolete "skip on release" lesson with
  the corrected understanding (the previous "main CI already validated"
  premise was wrong — main push doesn't run those jobs at all).

## 1.0.15 (2026-04-24)
- Fixed dapp-builder: stale dependency versions across SKILL.md and references
  - `freenet-stdlib` pinned to `0.6.0` (was `0.1` / `0.3.5`) to match current River
  - `freenet-scaffold` / `freenet-scaffold-macro` pinned to `0.2.2` (was `0.1`)
  - `dioxus` pinned to `0.7.3` with `features = ["web"]`
  - Added warning about stdlib version drift and wire-format errors
- Fixed dapp-builder/build-system.md: replaced stale `fdev publish --state ...` example
  with current `fdev -p 7509 publish ... contract --webapp-archive --webapp-metadata`
  form and noted `--code`/`--parameters` argument ordering vs the `contract` subcommand
- Added dapp-builder/contract-patterns.md "Contract WASM Upgrade & State Migration":
  end-to-end playbook for upgrading contract WASM without stranding state
  (authorized-state precondition, backwards-compatible serialization,
  `OptionalUpgrade` pointer, `legacy_contracts.toml` registry, CLI republish)
- Added Phase 1 step to plan contract upgrade from v1 alongside delegate migration
- Clarified two WebSocket connection models in ui-patterns.md: shell-managed
  (inside the gateway iframe, token injected, no manual `Authenticate`) vs raw
  (CLI / dev-server / direct node access, manual `Authenticate` required)
- Includes prior unreleased commit 265a7de: release skill Step 6 now enumerates
  the 12 required platform binaries explicitly (freenet/freenet-core#3825)
## 1.0.14 (2026-04-10)
- Fixed dapp-builder: WebSocket connection documentation was incorrect
  - WebSocket URL must be derived from `window.location`, not hardcoded to `ws://127.0.0.1:7509`
  - Must use path `/v1/contract/command?encodingProtocol=native`
  - Documented sandboxed iframe architecture (shell page postMessage bridge)
  - Added required `getrandom` js feature for wasm32-unknown-unknown
  - Added `freenet-stdlib` `net` feature requirement for WebApi
  - Bug discovered during ghostkey delegate development: hardcoded URL fails in gateway

## 1.0.13 (2026-04-07)
- Fixed release skill: River announcements now use `cargo run -p riverctl` from river repo instead of installed binary
- Installed `riverctl` embeds stale room_contract.wasm causing "missing contract parameters" failures
- Updated Room Owner VK in release skill to current value
- Added incident learning about stale WASM in installed riverctl

## 1.0.12 (2026-03-27)
- Updated systematic-debugging skill: added Phase 1b "When the Bug Is Reported from the Live Network" -- bridge from network telemetry observations to simulation reproduction with concrete translation table
- Added guidance for optional `telemetry-monitor` project-local skill integration
- Reinforced simulation-first philosophy: telemetry constrains the problem space, simulation reproduces it

## 1.0.11 (2026-03-27)
- Updated release skill: added 30-minute soak test step on non-gateway peer (nova local, or SSH peers framework/technic)
- Soak test runs between gateway update and announcements to catch resource leaks, log spam, and protocol regressions
- Skippable for urgent releases

## 1.0.10 (2026-03-26)
- Merged local-node skill content into local-dev: HTTP endpoints, dashboard scraping, WebSocket API protocol details, NodeDiagnostics config, config.toml reference, ring distance formula, fdev query/diagnostics commands

## 1.0.9 (2026-03-26)
- Updated release skill: River smoke test step, tmux tab naming, release.sh enforcement, matrix-commander Markdown fix, merge queue optimization docs
- Updated pr-creation skill: added Claude Rule Review handling
- Fixed phantom fdev commands in dapp-builder skill
- Added issue assignment checks to prevent duplicate work

## 1.0.8 (2026-03-08)
- Added local-dev skill for local node management and dApp iteration (`/freenet:local-dev`)

## 1.0.7 (2026-02-26)
- Added linux-test skill: runs integration tests requiring Linux loopback range via Docker (`/freenet:linux-test`)
- Uses existing `docker/test-runner/` infrastructure for containerized test execution
- Includes known test mapping for macOS-incompatible tests (connectivity, blocked peers, delegate messaging)

## 1.0.6 (2026-02-25)
- Added 5 recurring bug-prevention patterns (from Feb 2025 fix review of 25 bugs) to review agents and skills
- Updated skeptical-reviewer: added Freenet-specific bug patterns section (select! fairness, fire-and-forget, state cleanup, backoff/jitter, deployment)
- Updated testing-reviewer: added test gap checklist for the 5 patterns
- Updated pr-review skill: added 5-pattern checklist to skeptical review step
- Updated pr-creation skill: added bug-prevention patterns section and checklist item
- Based on freenet-core#3271 analysis

## 1.0.5 (2026-02-22)
- Updated release skill: gateways are now updated immediately after cross-compile binaries are available (no 10-min polling delay)
- Removed --deploy-local and --deploy-remote flags (gateway updates are now automatic)
- Added incident learning: version mismatch when users install before gateways update

## 1.0.4 (2026-02-20)
- Updated release skill with universal content from local nova skill: error recovery, rollback, cross-compile binary waiting, incident learnings, common issues
- Removed nova-specific SSH commands from plugin release skill (those stay in local freenet-release skill)

## 1.0.3 (2026-02-20)
- Updated systematic-debugging: added 6 recurring bug patterns to hypothesis phase (silent failures, resource exhaustion, incomplete wiring, TTL races, safe-change regressions, mock divergence)
- Updated pr-creation: CI gap tests must be in same PR, simulation health metrics required not suggested, added wiring completeness and resource invariant sections
- Based on CI gap analysis from freenet-core#3141

## 1.0.2
- Added release skill

## 1.0.1 (2026-02-14)
- Added claude.md for version tracking
- Established version update workflow

## 1.0.0 (Initial Release)
- dapp-builder skill for building Freenet applications
- pr-creation skill for Freenet PR guidelines
- systematic-debugging skill for debugging methodology
- pr-review skill
- Claude Code hooks for cargo fmt and clippy
- Git pre-commit hooks
