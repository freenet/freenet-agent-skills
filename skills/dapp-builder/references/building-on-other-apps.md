# Building on Someone Else's Contract or Delegate

This file is the **consumer** side: you are integrating with an app you do not
own — reading River rooms, using the ghostkeys delegate, indexing another
project's contracts. Everything in `upgrade-and-migration.md` is written from
the *author's* side. The two problems are different, and solving the author's
one does not solve yours.

> **Adoption is thin, so check before you build on it.** The pointer mechanism
> below is new. Do not assume the app you depend on has published one — for most
> apps today the honest answer is that they have not, and your resolve will
> return `NeverPublished`. Resolve first, and keep the bundle-fetch fallback at
> the end of this file for the apps that have not published yet. Both beat a
> constant compiled into your build.

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
