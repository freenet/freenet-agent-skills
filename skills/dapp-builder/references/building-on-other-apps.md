# Building on Someone Else's Contract or Delegate

This file is the **consumer** side: you are integrating with an app you do not
own — reading River rooms, using the ghostkeys delegate, indexing another
project's contracts. Everything in `upgrade-and-migration.md` is written from
the *author's* side. The two problems are different, and solving the author's
one does not solve yours.

> **Adoption is thin, so check before you build on it.** The mechanism works and
> is live, but most apps still publish nothing.
>
> | app | `app_id` | pointer key |
> |---|---|---|
> | River | `river.room-contract` | `Ai4VLoC2jGdhpcB2UU8VPo3efUoxjm1Ju9VKXqRC63Az` |
> | River | `river.chat-delegate` | `6qF2H5JRPBxbKC45UtPnzdDzyfsejYFW1UwDLGDU66mu` |
> | Atlas | `atlas.index-contract` | `BwsKx5iDhjBJGDNAPtZbbC9f6twDAUrnb2Yh1D6Wng2K` |
> | Delta | `delta.site-contract` | `6a8ZBaFft9wVFd1mAWVRRZepXXrnQNzRCD5tqM71hBm5` |
> | Delta | `delta.site-delegate` | `ES2hnErmSh9Aip4862ZDKQCNvMeryfhj6b7FfpP5qmyZ` |
>
> That is the complete list as of 2026-08-18, and all five resolve on the live
> network today. Each app's author verifying key is published in **that app's
> own `FREENET.md`** — River's, Atlas's, Delta's — and you should **take it from
> there, not from this table**, for the reason given under "the author key is
> the whole trust anchor" below. This file deliberately lists only the pointer
> *addresses*, which are public routing information; the author key is the thing
> an attacker would want you to read from the wrong place.
>
> **The author keys are not all encoded the same way**, which will bite you if
> you write one parser and assume. River's and Delta's are `river:v1:vk:`-prefixed
> base58 (Delta reuses River's `web-container-tool` encoding; the prefix says
> nothing about ownership). Atlas's is bare hex. Both encodings decode to the
> same 32 raw bytes, and it is those 32 bytes the resolver wants.
>
> Everything else, including ghostkeys, has no record — so for those your
> resolve returns `NeverPublished` (a real "not found") or `Unavailable` (your
> transport could not tell), and the baked-in fallback is legitimately what you
> use. Worth noticing that ghostkeys — the app whose re-keys caused the breakage
> this file exists to prevent — is still in that group, so the reader most likely
> to reach for a pointer is the one it cannot yet help.
>
> So: resolve first, and keep the bundle-fetch fallback at the end of this file
> for the apps that have not published. Both beat a constant compiled into your
> build, and the fallback stops being needed one app at a time rather than all
> at once.

## The failure, stated once

A contract or delegate key is `BLAKE3(BLAKE3(wasm) ‖ params)`. It moves whenever
the WASM moves — a feature, a dependency bump, a rustc upgrade, a version bump
with no behaviour change at all. When the app you integrate with re-keys:

- **Their** users' data migrates forward, if they did their job. Solved.
- **Your** reference does not. It is a constant you compiled in. After the
  re-key it addresses an empty namespace.

The failure is silent and it lies to you. Every read comes back looking exactly
like "this user has nothing stored" — not like an error — because at the
protocol level those two are indistinguishable. Your error handling cannot help.

This is not hypothetical. The ghostkeys delegate re-keyed twice in one day for
release-hygiene reasons with no behaviour change; every integration broke, and
the first anyone knew was a user reporting that their Ghost Key worked in the
vault but not elsewhere — the integrating app had told them to go and buy one
they already owned ([freenet/ghostkeys#21](https://github.com/freenet/ghostkeys/issues/21)).

**A backward probe does not rescue you.** The legacy-code-hash registry in
`upgrade-and-migration.md` searches *backward* from a current key, to recover
state the author's own users left behind. As an integrator you have the opposite
problem: you are pinned to a key that is now the *old* one, and there is nothing
backward about the thing you need to find. Pinning a version of the author's
crate does not help either — it pins you to *their* view of the key as of their
release, which is precisely the thing that went stale.

## The mechanism: an author-signed pointer

A shared, frozen pointer WASM is addressed at a derivable address per
`(author_vk, app_id)`. Its state is 100 bytes: an author-signed
`{version, code_hash, signature}` naming the **current code hash** of some other
contract or delegate. You resolve it at runtime and derive the key you actually
wanted.

Because the pointer WASM is frozen and its address is derived from the author's
key plus a name, you need no prior reference to the thing you are addressing —
which is what makes this work for a third party. The in-state `OptionalUpgrade`
pointer in `contract-patterns.md` is a different thing: it is per-instance and
only findable by a client that already holds a reference to *that* contract. The
`FacadePointer` in `facade-pattern.md` is a third thing again: it moves an
audience to a different contract, for the author's own users.

Mechanics, wire format, and the operational requirements are in the contract's
own README — do not restate them here, or the two copies drift:
<https://github.com/freenet/freenet-migrate/blob/main/contracts/pointer-contract/README.md>

## Do you actually need one? The pinned-in-time test

Resolving is not free, and adding it where it cannot help buys you a network
dependency and a new failure path in exchange for nothing. One question decides
it:

**Are you pinned in time relative to the thing you address?**

You are pinned, and you need a pointer, if a copy of your code can still be
running long after the artifact it addresses has moved. The clearest case is a
CLI installed from a registry: `riverctl` is installed from crates.io and kept
for months, so the contract generation compiled into it silently becomes older
than the live one. Anything a user installs, vendors, or bundles is in this
group, and so is any server or bot deployed on its own schedule.

You are NOT pinned, on engineering grounds alone, if you are rebuilt and
redelivered whenever the thing you address changes. A Freenet web app is the
usual example: it ships inside a web container republished in place, and changing
the contract forces a UI rebuild and republish, so the UI's idea of "current"
cannot lag reality. Resolving your own artifact's pointer there is close to
circular, since the answer is already compiled into you.

Two things make this test sharper than it first looks.

**Vendoring a copy is the same trap with an extra step.** Committing another
project's WASM into your repo pins you exactly as hardcoding its key would, and
it looks like a build artifact rather than a stale reference. One app in this
ecosystem vendored a delegate that was six generations and three months stale,
and registered it on every startup.

**A backward-searching recovery cannot rescue a stale anchor.** If your migration
walks *older* generations from where you think "current" is, and your idea of
current is itself out of date, the live state is FORWARD of everywhere you will
look. You will not merely miss it; you may find an ancient copy and write it
forward onto a retired address. A build-time assertion that your bundled hash is
current cannot help here, because it protects the binary when it is built, not
when it is run.

### The deliberate exception: River's UI

River's UI resolves its pointer even though the test above says it does not need
to. That is a considered decision by the project lead, not a counterexample, and
the reason is that River's UI is the reference people read when learning to build
Freenet apps: it should demonstrate the mechanism it recommends. It also buys a
real capability, shipping a contract upgrade without republishing the UI.

If you copy that choice, copy its constraint too. Resolving forward means an old
copy of your app can meet a NEWER artifact, which inverts the compatibility
direction: ordinarily new code reads old state, and here old code must cope with
new state. The dangerous half is not reading but WRITING, because an old client
that parses new state, silently drops what it does not understand, merges and
writes back has destroyed those fields while reporting success.

The bound worth adopting is the one in the outcome table below: **refuse to write
to a generation you do not recognise, and stay read-only until reloaded.** That
removes the round-trip destruction without requiring you to promise forward
compatibility forever.

## Resolving one

```rust
use freenet_migrate::pointer::{resolve_app_pointer, PointerFloor, PointerOutcome};

// AUTHOR_VK is a build-time constant from the app's FREENET.md. See below.
let floor = match load_stored_floor(AUTHOR_VK, b"river.room-contract") {
    Ok(Some(f)) => f,                       // a floor we previously persisted
    Ok(None)    => seeded_floor(),          // no row yet -> seed, see trap 3
    Err(e)      => return Err(e),           // stored but unreadable -> SURFACE IT
};

let outcome = resolve_app_pointer(&mut io, &AUTHOR_VK, b"river.room-contract", floor).await?;
```

In a browser UI, whose WebSocket handler is shared and has no awaitable
request/response correlation, use `PointerResolver` — the same logic as a
sans-IO driver you pump from your existing response handler — instead of the
`async fn`. Do not run two concurrent resolutions for the same
`(author_vk, app_id)` on a shared handler.

**Re-resolve periodically and on every reconnect.** A single resolve at startup
leaves you pinned for the life of the session, and repeated resolving is the
only thing that bounds how long an author's newer record can be suppressed from
you. Subscribing to the pointer is a best-effort accelerant, not a substitute:
subscriptions are dropped silently across reconnects.

### Four things people get wrong

**1. `author_vk` is the entire trust anchor.** It must be a build-time constant,
taken from the app's `FREENET.md` — never fetched from the network, or you have
simply moved the problem. Note that nothing binds a key to a name: a
typosquatter can publish a validly-signed pointer under a plausible `app_id`, so
a correct signature proves the record came from *that key*, not that the key is
who you think it is.

**2. Derive with YOUR OWN params, never the pointer's.** The pointer tells you a
*code hash*, not a key. The pointer's params identify the pointer; yours
identify the instance you want — the room owner's key, your delegate's config,
whatever it is for you.

```rust
let id = resolved.contract_id(&my_own_params);   // NOT the pointer's params
let dk = resolved.delegate_key(&my_own_params);
```

`contract_id` returns a `ContractInstanceId`, which is what GET and SUBSCRIBE
take. An UPDATE currently needs a full `ContractKey`, so do not store the
instance id and assume it is enough for every operation
([freenet-core#4978](https://github.com/freenet/freenet-core/issues/4978)).

**3. Persist `outcome.next_floor()`, keyed by `(author_vk, app_id)` — and seed
the first one.** This is the anti-rollback floor. Store `version`, `code_hash`
**and** `is_withdrawn`, and rebuild with `PointerFloor::at` /
`PointerFloor::withdrawn_at`; do not infer withdrawal from a zeroed hash column.

Two failure shapes here, both easy to write by accident:

- *Starting at `never_resolved` when you know better.* A first resolve has
  nothing to compare against, so it adopts any validly-signed record a peer
  serves, including a genuine but superseded one. If you ship knowing the app's
  current version and code hash, seed the first floor from those constants with
  `PointerFloor::at`.
- *Recovering from a corrupt floor with
  `unwrap_or_else(|_| PointerFloor::never_resolved())`.* This is the first thing
  to reach for and the crate explicitly forbids it: it converts a corrupt floor
  into "first run", which is the one state that unlocks the baked-in fallback.
  An absent row is legitimately `never_resolved`; a stored floor that fails to
  rebuild is untrustworthy and must surface.

Persisting after a **withdrawal** matters most: a withdrawal is a signed record
at a version like any other, so if you stop resolving without recording its
version, your floor stays at the pre-withdrawal value and any peer can serve a
real, validly signed pre-withdrawal record that resurrects code the author
explicitly withdrew.

**How durable does the floor need to be? At least as durable as whatever it
guards, and stored next to it.** "Persist it" is not a strong enough
instruction, because it invites `localStorage`, which an attacker can clear and
a user can clear by accident. Use this test instead: a floor that outlives the
thing it protects is merely wasteful, while a floor that dies before it is a
hole, because clearing the floor is exactly as good to an attacker as defeating
it. So a resolver holding nothing but a cached address can keep its floor
wherever that address lives, and a consumer using the record to gate access to
secrets must keep the floor in the same store as those secrets. Co-location is
the point: the two must be lost together or not at all, or "clear the floor,
then replay an old record" becomes a working attack.

The corollary is reassuring, and worth stating so nobody builds a defence
against it: a freshly installed OLD version cannot be exploited this way. That
instance starts with an empty floor AND an empty store, so there is nothing to
steal. The floor and the data it guards are born together; the danger is only
in separating them afterwards.

(Rule contributed by the delegate-succession work, where the record gates a
transfer of secrets rather than naming an address.)

**4. Handle every arm.** `PointerOutcome` has seven variants and only two carry
a record. The tempting shape

```rust
if let Some(r) = outcome.resolved() { use_it(r) }        // WRONG
```

silently no-ops on the other five, so a withdrawal, a rollback attempt and a
plain timeout all collapse into "nothing happened".

| Outcome | What it means | What to do |
|---|---|---|
| `Resolved` / `Unchanged` | verified record | derive your key from it |
| `Withdrawn` | the author retired this artifact | persist the floor **first**, then stop. Do **not** fall back to a baked-in key: the author is saying there is no current code, not that the old code is current again |
| `NeverPublished` | the network answered definitively that no pointer has ever been published here, and none has ever resolved on this install | the **only** case where a baked-in key is legitimate |
| `Stale` | a peer served a validly-signed record older than your floor, already refused | keep your last resolved key; retry. **Routine, not an attack signal** — a freshly bootstrapped or recently evicted node has no prior state to compare against, so it can transiently serve an older record |
| `CompetingRecord` | two author-signed records exist at the same version | keep your last resolved key; do not pick between them. (There is a documented case where deriving from your own floor is legitimate, since the network's merge converges on the lower code hash and your floor already holds it — but it turns on your floor's *provenance*, so read the variant's docs before relying on it) |
| `Unavailable` | nothing could be learned — timeout, failure, empty body, or a pointer reported absent that has resolved before | keep your last resolved key; retry. Silence is not absence, and an attacker who can briefly break reachability must not thereby win a downgrade |

> **If your floor is a withdrawal, "keep your last resolved key" never applies.**
> A tombstone sorts below every real code hash, so once you hold a withdrawal
> floor, a genuine pre-withdrawal record replayed at that version loses the
> tiebreak and surfaces as `CompetingRecord` (or as `Stale`, one version down).
> Following the table literally there resumes the retired code out of your own
> memory — the same resurrection the withdrawal floor exists to prevent, reached
> from the other side. Check `floor.is_withdrawn()` on both rows and stay
> stopped, exactly as for `Withdrawn`.

`outcome.may_use_baked_in_fallback()` encodes the fallback rule so you do not
have to re-derive it; it is true for `NeverPublished` and nothing else.

"Keep your last resolved key" is doing real work in those rows: the failure you
are guarding against is an attacker who makes the pointer briefly unreachable,
or replays an old record, and collects a downgrade from a client that treats
either as "no pointer, use the built-in default".

`PointerOutcome` is `#[non_exhaustive]`, so match with a `_ =>` arm rather than
exhaustively — and route that arm to keep-your-key-and-retry, which is the safe
default for anything added later.

**Errors are not a fallback trigger either.** `resolve_app_pointer` returns
`Err` for transport failures and malformed responses. Both are retryable and
neither permits the baked-in key: answering a single GET with 99 bytes is the
cheapest hostile move available, so a client that treats `Err` as "no pointer"
undoes the whole outcome table.

**A resolved pointer you cannot fetch is normal.** The record can verify while
the code it names is momentarily unfetchable. Retry with backoff, keep the
derived key, and report "the current version could not be fetched" — never "this
user has no data".

## What the pointer does NOT give you

**It solves addressing only.** It tells you where the artifact is now. It says
nothing about whether the state or secrets held under the previous key survived
the move, and assuming they did produces a bug that looks like "this user has no
data" rather than an error.

Be concrete about it: a design review of River found (as of 2026-08) that
delegate secrets written to its dedicated secure namespace do **not** survive a
delegate re-key, while secrets written to its readable blob do, because the
migration probe only reaches the latter — and River re-keys roughly weekly. So
an integrator who resolves River's delegate pointer correctly, and then assumes
the user's secrets came with it, will be wrong for every secret in that
namespace. Resolving the pointer correctly is necessary for a safe upgrade and
nowhere near sufficient.

Worse, the gap can be **silent on both sides**, so neither you nor the app you
depend on learns anything went wrong. Freenet's host-side secret enumeration is
best-effort by design, and its own source says so: `list_secret_keys` calls
`unwrap_or_default()` on an unreadable key registry, so it returns an **empty
list** rather than an error, and `register_key` can store a value while
declining to register it (an unreadable registry, or a 4096 live-key ceiling),
warning only on the node. So a handover that enumerates what it holds, ships
what it finds, and reports success can move a subset and be unable to tell.
Resolve the pointer perfectly, derive the right key, receive an honest success,
and still find data missing, with no error anywhere and nothing the user can
inspect. (Verified in `secrets_store/store.rs` as of 2026-08. Neither River nor
ghostkeys is exposed today, because both use their own app-level protocols
rather than host enumeration; a design that enumerates directly is.)

The rule that falls out: **treat "the data arrived" as a separate claim needing
its own evidence.** Never infer it from a successful resolve, and never infer it
from the mover reporting success either.

What you *do* get, and it is the thing that was missing in the ghostkeys
incident, is the ability to tell **"the thing I was built against moved"** apart
from **"this user has no data"**.

## If the app you depend on has not published a pointer

Today that is the common case, so expect to need this. Ask them to publish one.
Until they do, the field-proven fallback is to fetch their current key at
runtime from something whose address *is* stable — typically a file inside their
webapp bundle, since a web container's id is derived from fixed WASM and fixed
params, so publishing a new version changes its state and not its id. That
pattern, its CSP/CORS behaviour inside a sandboxed webapp, and its three rules
are in `delegate-patterns.md` → "Depending on Someone Else's Delegate".

It works, and it needs no new infrastructure. What it does not give you is
anything *your* code verifies: no signature you check client-side, no
anti-rollback floor, and no way for the author to say "withdrawn".

## If you are the author

Publishing a pointer is the courtesy that keeps your integrators alive across
your own re-keys, and it costs one signed 100-byte record per release.

- **`app_id` names the artifact, not its kind**: `<project>.<artifact>`, e.g.
  `river.room-contract`, `river.chat-delegate`, `ghostkeys.ghostkey-delegate`.
  Charset is lowercase `[a-z0-9._-]`, 1–64 bytes.
- **Publish your `author_vk` in your `FREENET.md`.** It is your integrators'
  trust anchor and they are told to take it from there.
- **The author key is a long-lived identity.** Keep it offline; it is not a
  per-release key and there is deliberately no delegated signing.
- **Gate `version` on a single committed monotonic counter**, the way a
  web-container version counter works — never a wall-clock timestamp.
- **PUT the committed, published WASM artifact; never a local rebuild.** A local
  rebuild puts your pointer at an address nobody else derives: invisible to every
  consumer, and indistinguishable from success on your side.
- Publishing a pointer does not relieve you of the backward probe. They answer
  different questions — the probe moves *your users' state* forward, the pointer
  tells *other people* where you went.

## Cross-references

- `delegate-patterns.md` → "Depending on Someone Else's Delegate" — the
  webapp-bundle fallback and how to read `DelegateError` on the client.
- `upgrade-and-migration.md` — the author-side playbook, including the pointer
  as a stable identity anchor.
- `contract-patterns.md` — the in-state `OptionalUpgrade` pointer, a different
  mechanism for a different reader.
- `facade-pattern.md` — the `FacadePointer`, a third mechanism again, for moving
  your own audience to a different contract.
- freenet-core#2776 — live adoption status.
