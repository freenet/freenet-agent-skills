# Building on Someone Else's Contract or Delegate

This file is the **consumer** side: you are integrating with an app you do not
own — reading River rooms, using the ghostkeys delegate, indexing another
project's contracts. Everything in `upgrade-and-migration.md` is written from
the *author's* side. The two problems are different, and solving the author's
one does not solve yours.

> **Check before you build on it.** Apps that publish pointer records list them,
> with the author verifying key, in their own `FREENET.md`. River, Delta, Atlas and
> ghostkeys do today. Take the key from that file, not from a copy elsewhere, for
> the reason under "`author_vk` is the entire trust anchor". Author keys are not all
> encoded the same way (`river:v1:vk:`-prefixed base58 or bare hex). All decode to
> the same 32 raw bytes, and those are what the resolver wants.
>
> An app with no record resolves to `NeverPublished`, the one outcome that permits a
> baked-in key. The bundle fetch under "If the app you depend on has not published
> a pointer" is still better. `Unavailable` is not that case: your transport could
> not tell, so retry. Treating "could not reach it" as "it does not exist" is a free
> downgrade for anyone who can drop your GET.

## The failure, stated once

A contract or delegate key is `BLAKE3(BLAKE3(wasm) ‖ params)`. It moves whenever
the WASM moves — a feature, a dependency bump, a rustc upgrade, a version bump
with no behaviour change at all. When the app you integrate with re-keys:

- **Their** users' data migrates forward, if they did their job. Solved.
- **Your** reference does not. It is a constant you compiled in. After the
  re-key it addresses an empty namespace.

The failure misleads. For a delegate, a node without the old key answers
`DelegateError::Missing`, and a node that still has it runs the old WASM against
its old namespace, so anything written since the re-key looks absent with no
error. For a contract, you read a stale or empty generation.

This is not hypothetical. The ghostkeys delegate re-keyed twice in one day for
release-hygiene reasons with no behaviour change; every integration broke, and
the first anyone knew was a user reporting that their Ghost Key worked in the
vault but not elsewhere — the integrating app had told them to go and buy one
they already owned ([freenet/ghostkeys#21](https://github.com/freenet/ghostkeys/issues/21)).

**A backward probe does not rescue you.** The legacy-code-hash registry in
`upgrade-and-migration.md` searches *backward* from a current key, to recover
state the author's own users left behind. As an integrator you have the opposite
problem: you are pinned to a key that is now the *old* one, and there is nothing
backward about the thing you need to find. A backward search can even find an
ancient copy and write it forward onto a retired address. Pinning a version of the
author's crate does not help either: it pins you to *their* view of the key as of
their release, which is precisely the thing that went stale.

## Check an existing app first

```bash
# Any hit on another project's key means the app breaks on their next re-key.
grep -rniE "delegate_key|DELEGATE_KEY|delegate_code_hash|ghostkeys.*delegate" \
    --include=*.ts --include=*.js --include=*.rs --include=*.json \
    --include=*.toml . | grep -v node_modules
```

A hit in a build config, a generated constants file, or a `vite.config` /
`build.rs` define is the pattern that breaks. Replace it with a runtime lookup.

## The mechanism: an author-signed pointer

A shared, frozen pointer WASM is addressed at a derivable address per
`(author_vk, app_id)`. Its state is 100 bytes: an author-signed
`{version, code_hash, signature}` naming the **current code hash** of some other
contract or delegate. You resolve it at runtime and derive the key you actually
wanted.

Because the pointer WASM is frozen and its address derives from the author's key plus
a name, a third party needs no prior reference. Three other things share the word and
are not this. `OptionalUpgrade` is per-instance. `FacadePointer` (`facade-pattern.md`)
moves an author's own audience. `freenet_migrate::SuccessorPointer` is an older
primitive signing under a different domain: importing it compiles and never verifies.
New integrations should not use it.


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

**Vendoring a copy is the same trap with an extra step.** Committing another
project's WASM into your repo pins you exactly as hardcoding its key would, and
it looks like a build artifact rather than a stale reference. One app in this
ecosystem vendored a delegate that was six generations and three months stale,
and registered it on every startup.

### Exception: River's UI

River's UI resolves its pointer anyway, on purpose: it is the reference app, and it can
ship a contract upgrade without republishing the UI. If you copy that, copy its
constraint. Resolving forward means an old copy of your app can meet a newer artifact,
and an old client that parses new state, drops what it does not understand and writes
back destroys those fields while reporting success. **Refuse to write to a generation
you do not recognise, and stay read-only until reloaded.**


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

### The transport you hand it

`resolve_app_pointer` drives a `PointerIo` you implement, and two properties of
that implementation are load-bearing.

**Its result type is three-way on purpose.** `PointerFetch` is `State` / `Absent` /
`Unreachable`. `Absent` means you asked and were told no. A timeout, a send failure or
a malformed reply is `Unreachable`. Collapse them into an `Option` and you can never
reach `NeverPublished`. Only a real "not found" may be reported as `Absent`.

**The GET must not request the contract code.** The 100-byte record is the whole
answer and the pointer WASM is about 130 KB. `ConservativeProbeIo` adapts an existing
`ProbeIo` but inherits that cost, so implement `PointerIo` directly for anything that
resolves often.


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

**Keep the floor at least as durable as what it guards, and next to it.** Not
`localStorage`, which an attacker or a user can clear. A floor that dies before the
thing it protects is a hole, because clearing it is as good as defeating it. A
resolver holding only a cached address can keep the floor with that address. A
consumer using the record to gate access to secrets must keep the floor in the same
store as those secrets, so the two are lost together or not at all.

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

**It solves addressing only.** It says where the artifact is now, and nothing about
whether state or secrets under the previous key survived. Delegate secrets move only
when the app's own UI has run on that user's node, so you can resolve perfectly,
derive the right key and still find an empty namespace. See `delegate-migration.md`.

**Treat "the data arrived" as a separate claim needing its own evidence.** Never
infer it from a successful resolve or from the mover reporting success. Say "could
not find your data", not "you have none".

What you do get, and what was missing in the ghostkeys incident, is the ability to
tell "the thing I was built against moved" apart from "this user has no data".

## If the app you depend on has not published a pointer

Ask them to publish one. Until they do, the fallback is to fetch their current key at
runtime from something whose address is stable, typically a file inside their webapp
bundle. A web container's id is derived from fixed WASM and fixed params, so publishing
a new version changes its state and not its id. ghostkeys publishes such a file
alongside its pointer:

```js
const VAULT = 'DLog47hEsrtuGT4N5XCeMBG45m4n1aWM89tBZXue2E1N';  // ghostkeys vault
const { delegate_key_bytes, code_hash_bytes } =
  await (await fetch(`/v1/contract/web/${VAULT}/delegate-key.json`)).json();
```

This works from inside a sandboxed webapp: the gateway serves bundle files with
`Access-Control-Allow-Origin: *`, and the sandbox CSP permits `connect-src` to the
gateway origin. `localStorage` throws in that frame, so a webapp's durable client
state, migration markers included, has to live in the delegate's secret store.

Three rules:

- **Re-fetch on load, cache only for the session.** Persisting it recreates the
  problem with extra steps.
- **On a failed fetch, do not fall back to a stored key.** The webapp and the
  delegate are published together, so a node lacking one almost certainly lacks
  the other. "Not available on this node" is the honest reading.
- **You still hardcode one constant**, the webapp contract id. That is a smaller
  exposure, not zero: it would move if the *web container contract* were upgraded,
  which is a much larger and more visible event than a delegate re-key.

It works, and it needs no new infrastructure. What it does not give you is
anything *your* code verifies: no signature you check client-side, no
anti-rollback floor, and no way for the author to say "withdrawn".

## Reading delegate errors on the client

The client-side `DelegateError` (from `freenet-stdlib`, distinct from the
`DelegateError` your delegate's `process` returns) is what tells you *why* a
request did not work. Two variants are worth branching on:

| Variant | Means | What to do |
|---|---|---|
| `Missing(key)` | that delegate is **not registered** on this node | almost always a stale hardcoded key. Tell the user the app needs updating, and tell yourself: this is not "the user has no data" |
| `ExecutionError(msg)` | includes rate limiting after repeated failures | transient. Back off and retry; the message carries the delay |

**Do not treat `Missing` as proof the user has nothing stored.** `UnregisterDelegate`
removes a delegate's code while leaving its secrets in place, so a node can report
"no such delegate" while still holding data under it.

## If you are the author

Publishing a pointer is the courtesy that keeps your integrators alive across
your own re-keys, and it costs one signed 100-byte record per release.

- **`app_id` names the artifact, not its kind**: `<project>.<artifact>`, e.g.
  `river.room-contract`, `river.chat-delegate`, `ghostkeys.ghostkey-delegate`.
  Charset is lowercase `[a-z0-9._-]`, 1–64 bytes.
- **Publish your `author_vk` in your `FREENET.md`.** It is your integrators'
  trust anchor and they are told to take it from there.
- **Keep what you publish in step with what it names.** If you also publish a key
  file, write it in the same operation that changes the key, and gate the publish on
  the two agreeing.
- **Batch version bumps with functional changes.** A bump alone re-keys the artifact
  for nothing.
- **The author key is a long-lived identity.** There is no delegated signing, and
  rotating it moves every pointer address, so keep it offline if you can. River,
  Delta and ghostkeys reuse their web-container key and say so in `FREENET.md`; do
  the same if you reuse yours.
- **Gate `version` on a single committed monotonic counter**, the way a
  web-container version counter works, never a wall-clock timestamp. You can never
  go back down, so a timestamp throws away most of the version space.
- **Re-read the pointer after publishing and confirm the version and code hash
  are the ones you meant.** A publish at an already-used version is a silent
  no-op *success* — the contract deliberately does not error on a stale update,
  because that would turn ordinary anti-entropy from a behind peer into a merge
  failure. The network will never tell you your release was ignored.
- **If you lose the counter's store, recover the version from the network, only
  from a record that verifies under your own key.** A restarted counter makes every
  later publish a no-op success. Adopting an unverified read-back is worse: a forged
  high version gets you to sign the next record just below the ceiling, and you
  cannot walk it back down.
- **PUT the committed, published WASM artifact; never a local rebuild.** A local
  rebuild puts your pointer at an address nobody else derives: invisible to every
  consumer, and indistinguishable from success on your side.
- Publishing a pointer does not relieve you of the backward probe. They answer
  different questions — the probe moves *your users' state* forward, the pointer
  tells *other people* where you went.

## Cross-references

- `upgrade-and-migration.md`: the author-side playbook, including the pointer
  as a stable identity anchor.
- `delegate-migration.md`: moving delegate secrets across a re-key.
- `facade-pattern.md`: the `FacadePointer`, a different mechanism, for moving your
  own audience to a different contract.
- freenet-core#2776: live adoption status.
