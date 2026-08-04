# Identity & Addressing Patterns

How to give users a short, stable, shareable identifier — an "address" — without
leaking raw key material or coupling identity to a contract's WASM version.

This file is for any dApp where one user needs to reference another: messaging,
contacts, profiles, follow graphs, mentions. River identifies a room by the
owner's `VerifyingKey`; an email-style app identifies an inbox by its owner. The
patterns below generalize that idea and fix the two ways the naive version goes
wrong: identifiers that are **too big to share** and identifiers that **break on
every WASM upgrade**.

## The problem: don't make raw key material the identifier

The naive design embeds a public key directly in whatever users copy around — a
`contact://` blob, a profile URL, a parameters struct. That works until the key
is large.

### Key material sizes

| Scheme | Public key | Notes |
|---|---|---|
| ed25519 / x25519 (elliptic curve) | 32 bytes | Small enough to embed directly. |
| ML-DSA (post-quantum signatures, FIPS 204) | ~1.3–2.6 KB | Signatures larger still (2.4–4.6 KB). |
| ML-KEM (post-quantum KEM, FIPS 203) | ~0.8–1.6 KB | Encapsulation key. |

Two things compound this:

1. **Signing and key encapsulation use different algorithms.** ML-DSA
   (signatures) and ML-KEM (key encapsulation) have incompatible key formats, so
   a post-quantum identity carries *at least two* large public keys — one of
   each. (Reusing a single key for both signing and encryption is poor practice
   even where the math allows it, e.g. an ed25519 key converted to x25519.)
2. **Naive encodings balloon further.** A JSON array-of-bytes (`[226,108,229,…]`)
   spends ~4 characters per byte, and base64 adds another 33%. ~3 KB of raw
   post-quantum keys became a **~15 KB `contact://` blob** in freenet-email
   before it was reworked.

A 15 KB blob is not a thing a user can put in "send me mail at ___". This is not
an EC-vs-PQ recommendation — quantum resistance is a real reason to choose large
keys. The rule is: **whatever key material you use, keep it out of identifiers
and out of routinely-transmitted parameters.**

## The pattern: self-certifying short identifiers

Make the identifier a **short hash of the public key**. Keep the full key in
contract *state*, not in parameters, and have the contract verify the binding.

```
addr_bytes = BLAKE3(public_key)[..N]              // raw truncated hash
address    = base58(addr_bytes)                   // human-facing display form
params     = { addr_bytes }                       // small — this is the identity
state      = { public_key, ... }                  // full key lives here
```

base58 is only the *display* encoding for humans; parameters and state store the
raw `addr_bytes`. Don't put a base58 string in parameters.

The contract's `validate_state` rejects any state whose key does not hash to the
address. The identifier is then **self-certifying**: given an address you can
fetch the contract, read the full key from its state, and verify it yourself —
no directory, no trusted lookup.

### Contract side

`VerifyingKey` below stands in for whatever long-term identity key the app uses
— `ed25519_dalek::VerifyingKey` is only 32 bytes, but for a post-quantum
identity it is the (kilobyte-scale) ML-DSA key, which is exactly the case this
pattern exists for.

```rust
/// Truncation length of the address, in bytes. See "Choosing N" below —
/// this is a security parameter, not just a UX one.
pub const ADDRESS_BYTES: usize = 16; // 128-bit second-preimage resistance

pub fn address_of(pubkey: &VerifyingKey) -> [u8; ADDRESS_BYTES] {
    let digest = blake3::hash(pubkey.as_bytes());
    digest.as_bytes()[..ADDRESS_BYTES]
        .try_into()
        .expect("slice length matches ADDRESS_BYTES")
}

#[derive(Serialize, Deserialize)]
pub struct InboxParameters {
    /// The whole identity of this contract instance — small and stable.
    /// Raw bytes, not the base58 display form.
    pub address: [u8; ADDRESS_BYTES],
}

#[derive(Serialize, Deserialize)]
pub struct InboxState {
    /// The long-term identity (signing) key the address is derived from.
    /// Possibly large (post-quantum). Lives in state, never in parameters.
    pub owner_pubkey: VerifyingKey,
    pub messages: Vec<InboxMessage>,
    // ...
}

fn validate_state(
    parameters: Parameters<'static>,
    state: State<'static>,
    _related: RelatedContracts<'static>,
) -> Result<ValidateResult, ContractError> {
    // `decode` here is whatever deserializer the contract uses (e.g. ciborium —
    // see state-authorization-patterns.md on canonical encoding).
    let params: InboxParameters = decode(&parameters)?;
    let st: InboxState = decode(&state)?;

    // Bind state to the address. Without this check an untrusted peer could
    // serve a contract at this address carrying somebody else's key.
    if address_of(&st.owner_pubkey) != params.address {
        return Ok(ValidateResult::Invalid);
    }

    // ...then verify every signed field against st.owner_pubkey as usual
    // (see contract-patterns.md "Cryptographic Verification").
    Ok(ValidateResult::Valid)
}
```

Putting a short code in parameters does **not** make the contract *key* smaller
— `contract_key = BLAKE3(BLAKE3(wasm) || params)` is a fixed-size hash either
way. What it makes smaller is the **address users share** and the **parameters
every client must carry** to GET/PUT/subscribe the instance. The full key still
has to exist somewhere for signature verification — that somewhere is state, and
the `address_of` check is what keeps it trustless.

**Which key does the address commit to?** Derive the address from the
**long-term identity (signing) key only**, even when the identity has several
keys — a post-quantum identity has at least an ML-DSA signing key and an ML-KEM
encapsulation key. Store the other keys as ordinary state fields signed by the
identity key, and have `validate_state` reject any state where that signature is
missing or invalid (see `state-authorization-patterns.md`). They are then bound
to the identity transitively, and — because they are not baked into the address
— the user can rotate an encryption key without their address changing.

### Choosing N (this is a security parameter)

Truncating a hash trades collision resistance for length. The relevant property
for an address is **second-preimage resistance**: can an attacker grind a
*different* keypair whose hash truncates to the same address? If they can, they
can stand up a state for *your* address carrying *their* key — `validate_state`'s
hash check passes for both keys. A contract-side tie-break cannot rescue this:
"first writer wins" is unenforceable in a permissionless, eventually-consistent
store (there is no global clock, and an attacker can claim an earlier
timestamp), and any deterministic ordering on the key bytes is itself grindable —
the attacker keeps grinding until their colliding key also wins the tie-break.
**Address length is the only real defense; size it so grinding a second preimage
is infeasible.**

| Bytes (N) | base58 chars | Grind cost | Use for |
|---|---|---|---|
| 8 (~64 bits) | ~11 | Feasible for a determined attacker | Throwaway / low-value identities only |
| 10 (~80 bits) | ~14 | Expensive but not impossible | Reasonable floor for real identities |
| 16 (128 bits) | ~22 | Infeasible | **Default for anything someone could profit from impersonating** |

Default to **16 bytes**. Go shorter only when the identity is genuinely
low-stakes, and document the choice. (For comparison, Delta's `AmcVD92D3U`-style
codes are ~10 base58 characters — fine for low-value identifiers, short of the
128-bit bar for anything an attacker would pay to impersonate.)

## Identity must not be a contract key

A user's identity has to survive contract upgrades. The address does; a contract
key does not:

- `address = base58(BLAKE3(public_key)[..N])` depends **only on the user's
  keypair**. It never changes.
- `contract_key = BLAKE3(BLAKE3(wasm) || params)` changes **every time the
  contract WASM changes** (code edits, dependency bumps — see
  `contract-patterns.md`).

So:

- **Publish and share the address, never a contract key.** "Send me mail at
  `AmcVD92D3U…`" must resolve correctly after the next WASM release.
- The app resolves `address → contract_key` itself, by hashing the address with
  the WASM it currently bundles. Old clients compute the old key, updated
  clients compute the new key.
- On a WASM upgrade the address is unchanged; only the contract key moves. The
  migration playbook in `contract-patterns.md` ("Contract WASM Upgrade & State
  Migration") copies state from the old key to the new key — **both under the
  same address**.

River already follows the spirit of this: a room's identity is the owner's
`VerifyingKey` (key-derived and stable), not the room contract key, and
migration moves the contract under that stable owner key. The refinement here is
only for when the key itself is too large to *be* the identifier — hash it to a
short code and use that. If you ever find yourself about to hand a user a
contract key as their permanent handle, stop: the next WASM change will break
every copy of it.

## Keep it out of the user's face

Large or not, key material and even the address itself should rarely surface in
the UI. From the freenet-email design discussion:

- Users interact with **human aliases and contacts**, not raw addresses. The
  address is plumbing.
- Importing someone's address should be a **one-time** action — a copy-paste, a
  deep link, or a QR scan — after which the app refers to them by alias.
- An address (the short code) is also usable directly as a destination without
  first being saved as a contact; saving a contact is a convenience on top.
- Internally the app maintains the mapping `alias ↔ address ↔ resolved
  contract key`. Only the address is shared between users; the contract key is
  recomputed locally and never travels.

If a 15 KB blob is the thing users paste, the design is wrong somewhere above —
revisit it before shipping.

## Cryptographic CAPTCHA: is a real person behind this key?

The patterns above make an identity *unforgeable*. They do nothing to make it
*costly* or *accountable*. Sooner or later any dApp that accepts writes from
strangers has to answer a different question: is there a real, accountable
person behind this key, or is it one of ten thousand an attacker minted this
morning? It comes up at signup, at "join this room", at posting, at voting, at
listing something for sale, and at every rate limit you will eventually need.

On the normal web you drop in a CAPTCHA. That needs a server you do not have,
it shows your users to a third party, and machines now solve the puzzles better
than people do. A Freenet dApp has to answer the question without a server. Two
mechanisms do that: **proof-of-work** and **ghost keys**. They are usually
presented as alternatives. They compose better than they compete, and the
combination below is the actual recommendation — read both first, because the
combination works by cancelling out the specific weakness of each.

### Proof-of-work

The client grinds a hash until the digest meets a difficulty target bound to
the new identity, and the contract checks the digest in `update_state`. No
server, no money, no account, and verification costs microseconds.

Four problems, in rough order of how much they hurt:

1. **The asymmetry runs backwards.** A rented GPU grinds orders of magnitude
   faster than a phone browser running WASM SHA-256. Any difficulty high enough
   to deter an attacker who wants ten thousand identities is high enough to
   make an ordinary user wait and drain their battery. No setting hurts the
   attacker more than it hurts your users.
2. **The cost is burned.** Every unit of deterrence is electricity turned into
   heat and nothing else. The attacker pays in power, your users pay in power,
   and the value goes nowhere. Deterrence has to cost the payer something, but
   nothing about the mechanism requires the cost be *destroyed*.
3. **It proves only that someone spent cycles.** There is no amount, no date,
   nothing to tier trust on, and nothing that carries between apps. Every app
   charges its users again from scratch.
4. **The difficulty constant lives in your contract WASM.** Re-tuning it
   re-keys the contract and forces a migration (see `contract-patterns.md`), so
   the one parameter you will most want to adjust is the one that is most
   expensive to change.

Proof-of-work is still the right answer when you need genuinely zero friction,
no payment, and no prior setup, and when the abuse you are deterring is cheap
to clean up (throttling posts, slowing bulk account creation). It also has **no
issuer and no trust root** — there is no key whose compromise breaks it and no
party who can decline to serve a user. If your app's premise is that there is
no central authority anywhere in it, that property is worth more than
everything in the next section (see "The centralized mint"). Proof-of-work buys
time, not a wall.

### Ghost keys

A [ghost key](https://freenet.org/ghostkey/) is an Ed25519 keypair whose public
key was **blind-signed** ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html))
by Freenet after a donation. The holder ends up with a certificate proving *a
donation of $X was made on date Y* which cannot be linked back to the payment
or the payer, because the signer never saw the unblinded key. The anonymity is
a property of the math, not a promise in a privacy policy.

As a CAPTCHA replacement it answers the same question with better properties:

- **Monetary cost cannot be beaten with hardware.** The lowest tier is $1
  (tiers run $1 / $5 / $20 / $50 / $100), so ten thousand identities cost ten
  thousand dollars no matter what the attacker rents. This is the one cost
  model where buying more compute does not help.
- **The cost is transferred, not burned.** It buys the same deterrence as
  proof-of-work without converting it to waste heat. (Read the disclosure
  below on who receives it.)
- **It is graduated, not binary.** The certificate carries the amount and the
  date, so you can accept any ghost key for posting and require a $20 key or a
  six-month-old one for moderation, rather than making one pass/fail decision.
- **The user pays once, not once per app.** A ghost key is the user's, not
  yours; every Freenet app can ask for a signature from the same key. Contrast
  proof-of-work, which each app levies again.
- **Verification is offline.** Check an Ed25519 signature plus the certificate
  chain back to Freenet's master key. No callback to a CAPTCHA vendor, nothing
  that can rate-limit you or go away.
- **Signatures cannot be harvested.** The delegate never signs a bare message;
  it wraps it in a `ScopedPayload` carrying the runtime-attested identity of
  the requesting app. A signature obtained by app A does not verify as a
  signature made for app B.

### Integration sketch

**First, do not hardcode the delegate key.** It changes whenever the ghostkeys
delegate does — including on a bare version bump — and a stale reference fails
in the most misleading way available: every request looks exactly like "this
user has no ghost key". Fetch it instead:

```js
const VAULT = 'DLog47hEsrtuGT4N5XCeMBG45m4n1aWM89tBZXue2E1N';
const { delegate_key_bytes, code_hash_bytes } =
  await (await fetch(`/v1/contract/web/${VAULT}/delegate-key.json`)).json();
```

See `delegate-patterns.md` → "Depending on Someone Else's Delegate" for why,
what to do when the fetch fails, and the one constant that remains.

Your app never touches the private key. It sends a CBOR `GhostkeyRequest` to
the ghostkeys delegate via delegate messaging and gets back a
`GhostkeyResponse`. The permission prompt ("allow once / always allow / deny")
is rendered by the delegate and the runtime, so you do not implement any of it.

```rust
// ghostkey-common = "0.2.4"
use ghostkey_common::{GhostkeyRequest, GhostkeyResponse, to_cbor};

// Does this user have a ghost key at all? Answers WITHOUT prompting, and is
// deliberately not permission-filtered, so you can decide whether to show a
// "buy a ghost key" button before asking for anything.
let payload = to_cbor(&GhostkeyRequest::HasIdentity)?;
// -> GhostkeyResponse::IdentityPresence { usable, unusable }
//    `unusable` counts identities whose certificate is present but whose
//    signing key is gone. They appear in ListGhostKeys and look healthy right
//    up until they fail to sign, so a non-zero count is worth a different
//    message: that user needs their backup, not another purchase.

// To prove the user holds a ghost key, have them sign a challenge bound to
// your contract instance (see "Cross-Context Binding" in
// state-authorization-patterns.md -- the same rules apply here).
//
// Prefer SignWithDefault: it needs no fingerprint, so you never track one.
// If you hold no grant yet, the delegate shows the user a key picker and
// replays this request once they choose -- you do not need a separate
// RequestAnyAccess step first.
let payload = to_cbor(&GhostkeyRequest::SignWithDefault {
    message: challenge_bytes,
})?;

// Response:
GhostkeyResponse::SignResult {
    scoped_payload,   // CBOR ScopedPayload { requestor, payload }
    signature,        // Ed25519 over scoped_payload
    certificate_pem,  // chain, for offline verification
};
```

`RequestAnyAccess` still exists and is the right call when you want the user's
fingerprint up front (to display it, or to store it in contract state) rather
than just a signature. It always prompts, so it cannot be polled -- that is
what `HasIdentity` is for.

Two response variants are worth handling explicitly, and one of them is easy
to misread:

- **`NoIdentityAvailable`** means no identity is *available to sign with*:
  either the vault is empty, or every identity in it has lost its signing key.
  It is **not** returned merely because your app lacks permission -- if the
  vault holds keys you have no grant on, the delegate prompts the user
  instead. So you can treat it as "offer to buy one" without first checking
  whether it was really a permissions problem. Use `HasIdentity` to tell the
  empty case from the lost-signing-key case.
- **`AccessDenied`** means the user declined the prompt.

Neither is an error; both are ordinary UI states.

Note that `GetDefaultKey` returning `DefaultKeyResult { fingerprint: None }`
does **not** mean the user has no ghost key -- it means *you* have no `Sign`
grant on any of them. It never prompts, deliberately: an app must not be able
to put a dialog in front of the user just by asking a question.

### Sending a user off to buy one, and getting them back

If `HasIdentity` reports nothing usable, the user has to leave your app for
`freenet.org/ghostkey/create/`, pay, and import the key into their vault. That
round trip is the real cost of choosing ghost keys over proof-of-work, so do
not make them find their way back by hand:

```
https://freenet.org/ghostkey/create/?return_to=<your contract instance id>
```

The id rides through the payment flow into the vault's import link, and once
the key has actually landed the vault offers the user a one-click way back to
your app. Pass your contract instance id, not a URL -- the vault only ever
builds a same-origin `/v1/contract/web/<id>/` path from it, and rejects
anything that is not a valid id.

Add `&return_path=<percent-encoded relative route>` to come back to a specific
place rather than your app's root -- a sub-path, a `#route`, or both. Encode
it: it may contain its own `#`, and it is going into a fragment. The vault
still synthesises the `/v1/contract/web/<id>/` prefix itself, so the route only
decides what follows, and it is refused if it could climb out of your contract.

### Do not gate the action on a cached identity check

The one thing that reliably goes wrong in this flow: the app checks
`HasIdentity` once at load, renders "buy a ghost key", the user goes and buys
one -- and the tab they came back to is still the one that checked. It has no
idea anything happened. There is no callback from the vault to your app, and
the vault opens in a **new tab**, so their original tab can sit there
indefinitely insisting they have no key.

Do not solve this by polling or by listening for focus events. Solve it by not
depending on the cached answer in the first place:

- Use `HasIdentity` to decide what to **offer** -- whether to surface a
  buy-a-key path at all.
- Do **not** use it to decide whether the user may **attempt** the action. Let
  them try, call `SignWithDefault`, and branch on what comes back.

That works because `SignWithDefault` is authoritative at the moment it matters:
it prompts if you hold no grant, and returns `NoIdentityAvailable` only when
there is genuinely nothing to sign with. An app written this way needs to
detect nothing. A stale tab costs the user one extra click, not a dead end.

Verification can go through the delegate
(`GhostkeyRequest::VerifySignedMessage`, which returns `VerifyResult` with
`valid`, `signer_fingerprint`, and the donation metadata), or you can link
`ghostkey_lib` and verify the chain yourself. That library builds for
`wasm32-unknown-unknown` (the delegate is compiled from it), so verifying
in-contract is plausible, but note that `validate_state` runs on *every* state
load: verifying one certificate per member on every load scales badly. The
cheaper shape is the one River already uses for membership — verify once at
admission in `update_state`, then record a signed membership entry that later
loads check with a single Ed25519 verification.

### Recommended: proof-of-work with a ghost key escape hatch

Offer **both**. Run proof-of-work as the default path so nobody is ever
excluded, and offer the ghost key as a way to **skip the wait**.

Surface that offer *while the grind is running*. That is the right moment: the
user is blocked, has nothing to do, has already decided they want in, and is
being offered their own time back. Compare a payment prompt shown before they
have seen anything, which reads as a toll booth. The same offer, moved to the
progress bar, reads as a courtesy.

What the combination buys:

- **You can raise the difficulty.** Proof-of-work's core problem is that its
  asymmetry runs backwards, so difficulty is capped by what your slowest user
  will tolerate. With an escape hatch the user on a phone at 8% battery has an
  exit costing a dollar instead of twenty minutes, so you can set difficulty by
  what deters an attacker rather than by what the weakest device tolerates.
- **The attacker faces both walls at once.** Ten thousand identities cost ten
  thousand dollars *or* a serious pile of compute, and raising one wall does not
  lower the other.
- **Nobody is priced out.** The free path always completes. This is what
  defuses the $1 floor and the payment-rail objections below: payment and the
  centralized mint become an accelerator rather than a gate, so neither can
  exclude a user from your app.
- **Whoever pays, chose to, and got something for it.** They bought back their
  own time. That is a much easier thing to justify than charging admission.

Contract side, accept either proof against the same challenge:

```rust
enum AdmissionProof {
    /// Nonce whose digest meets the difficulty target.
    Work { nonce: u64 },
    /// Ghost key signature over the same challenge (see the sketch above).
    Ghostkey {
        scoped_payload: Vec<u8>,
        signature: Vec<u8>,
        certificate_pem: String,
    },
}
```

Both bind to the same challenge, so the new identity is committed either way and
`update_state` verifies whichever turned up.

Three things to get right:

- **Keep the free path genuinely completable.** If the grind takes forty
  minutes, the free option is decoration and you have built a paywall with extra
  steps. Calibrate it to a wait an ordinary device and an ordinary person will
  actually sit through.
- **Never slow the grind to drive conversions.** The incentive exists, this
  document has already disclosed that Freenet profits from the alternative, and
  doing it would be a dark pattern. Set difficulty from the deterrence you need,
  then leave it alone.
- **Decide whether the two proofs earn the same thing.** A ghost key carries an
  amount and a date; proof-of-work carries nothing, so you *can* grant the
  former more. But if the extra is anything a user actually needs, you have
  rebuilt the paywall you just avoided. Prefer granting identical access, and
  use ghost key metadata only for genuinely elevated roles such as moderation.

### Where ghost keys do not fit

They gate on *donation*, not on *humanity*. A funded attacker still buys in; it
just costs them. And the $1 floor is a real barrier: if your app needs open
signup at zero friction, or serves users for whom card payment is awkward or
impossible, a paid identity is the wrong gate and proof-of-work (or no gate at
all) is the honest answer. It is also strictly worse than proof-of-work for
throwaway or low-stakes identities, where the whole point is that they cost
nothing.

Note that every objection here is about using ghost keys as the *only* gate.
Offering them as the escape hatch above keeps the deterrence and removes the
barrier, which is why that is the recommended shape.

### The centralized mint

Ghost keys are anonymous but **centrally issued**. Freenet runs the signing
service and holds the key at the root of the certificate chain. In a platform
whose whole purpose is removing central points of trust, that is a real cost
and you should weigh it rather than wave it through.

Be precise about what it does and does not cost you, because "centralized"
usually implies more than it does here.

What it costs:

- **Issuance is a single point of failure.** If the service is down, or Freenet
  the organisation stops running it, nobody can obtain a *new* ghost key. Your
  onboarding stops with it.
- **There is a trust root to compromise.** Anyone who steals the master or a
  notary key can mint unlimited valid certificates, which collapses the
  scarcity your gate depends on. Proof-of-work has no equivalent key.
- **The payment rail is a chokepoint.** Card networks decline, geo-block, and
  deplatform. That is the same constraint as the $1 floor above, arriving as an
  availability problem rather than a cost one.

What it does not cost:

- **Verification stays decentralized.** Checking a certificate is offline, so
  existing ghost keys keep verifying even if the mint disappears tomorrow. The
  centralization is confined to minting new identities.
- **It is not a privacy centralization.** Blind signing means even a fully
  compromised donation server cannot correlate donors to keys. This is
  availability and trust-root risk, not surveillance risk.

Freenet's position is that this is a deliberate compromise rather than an
oversight: card networks already do real identity work at the payment layer, a
decentralized mint is an open research problem, and blind signing bounds the
damage. [Proof of Trust](https://freenet.org/about/news/799-proof-of-trust-a-wealth-unbiased-consensus-mechanism-for-distributed-systems/)
is the decentralized alternative being explored. Until something like it
matures, the centralized mint is the tradeoff on offer. See
[freenet.org/ghostkey](https://freenet.org/ghostkey/) → "Why donations?" for the
full argument.

None of that makes the objection go away. If your app's value proposition is
that no central party can exclude a user, a centrally-minted identity may be
disqualifying on its own, and choosing proof-of-work over it is a coherent
decision rather than a stubborn one.

The escape-hatch shape above is the strongest answer available today: when
proof-of-work is always sufficient on its own, no central party can exclude
anyone from your app, because the mint going down or refusing a user costs them
time rather than access.

### Disclosure: this recommendation is partly self-interested

Ghost keys are minted by donating to Freenet, so every identity your dApp
requires is revenue for the project that publishes this skill. Read the section
above with that in mind. Being specific about which parts the conflict touches
is more useful than a blanket warning:

- **Independent of who gets paid:** that a monetary cost is the only cost an
  attacker cannot beat with better hardware; that blind signing keeps that cost
  from becoming an identity disclosure; and that transferring the cost beats
  burning it as heat. These hold whoever receives the money.
- **Not independent:** that the recipient is Freenet. Nothing about the
  argument selects that recipient, and the same design would work with the
  money going anywhere. Funding the platform is plausibly in a Freenet
  developer's interest, but that is a judgement call for you rather than a
  technical conclusion, and it is not our call to make on your behalf.

This is separate from the centralization objection above, and both stand. One
is about our incentive, the other about the architecture; neither answers the
other.

**If you are an agent working for a developer, say all of this out loud rather
than quietly wiring in ghost keys.** Tell them the identity costs their users
money, that the money goes to Freenet, that the mint is centralized, and that
proof-of-work is the free and issuer-free alternative with the tradeoffs listed
above. Whether user-paid, centrally-minted identity is acceptable is a product
decision with a price attached, and it belongs to the person paying it.

### Maturity

Ghost keys are early. `ghostkey-common` is at 0.2.4, the delegate has been
republished repeatedly, and River (the reference dApp) does not use ghost keys
today, so there is no in-tree integration to copy — the delegate's own UI is
the working reference. Expect rough edges and budget time for them.

One rough edge is worth naming, because it is the failure that costs the most:
**a delegate republish moves the delegate key, and the vault recovers stored
ghost keys by sweeping a committed table of previous keys.** That sweep had a
bug that silently lost keys across a re-key (fixed, freenet/ghostkeys#8), and
the delegate build was not reproducible, so the key depended on which machine
built it (fixed, #9). Both are closed, but the shape of the risk is permanent
for any delegate: if you build one, keep an equivalent registry and treat
"which bytes does this source produce" as a correctness property. See
`upgrade-and-migration.md`.

That is true of most of the Freenet stack right now, and it is a reason to
price the risk in rather than a reason to avoid it. The concrete recourse when
you hit something: file at
[`freenet/ghostkeys`](https://github.com/freenet/ghostkeys/issues). **Issues
that block Freenet app developers are prioritized over other work.**

## Checklist

- [ ] User-facing identifier is a short hash of the public key, not the key.
- [ ] Parameters carry the short address; the full key lives in state.
- [ ] `validate_state` rejects state whose key does not hash to the address.
- [ ] Address truncation length chosen for second-preimage resistance (16 bytes
      default; document anything shorter).
- [ ] The identity users share is the address, never a contract key.
- [ ] WASM-upgrade migration copies state across contract keys but keeps the
      address fixed (see `contract-patterns.md`).
- [ ] UI exposes aliases; raw addresses appear only at import/export time.
- [ ] If strangers can write to the contract, you have decided *how* an identity
      is made costly (proof-of-work with a ghost key escape hatch, either alone,
      or a deliberate "no gate"), and the developer was told what that choice
      costs their users.
- [ ] If you offer both, the proof-of-work path alone is always sufficient for
      full access, and its difficulty was set by the deterrence needed rather
      than by how many users it converts.

## Cross-references

- `contract-patterns.md` — "Contract Parameters" and "Contract WASM Upgrade &
  State Migration".
- `state-authorization-patterns.md` — verifying signed state against the key,
  cross-context binding, and per-context identity (River's pattern of
  context-scoped keys, where a user deliberately has *no* global address — the
  opposite design choice to this doc, valid when unlinkability matters more than
  a stable handle).
- `delegate-patterns.md` — where the user's private keys are actually stored,
  and how to message another delegate (the mechanism the ghostkeys integration
  above uses).
- [`freenet/ghostkeys`](https://github.com/freenet/ghostkeys) — the delegate's
  README documents the full request/response protocol, the permission model,
  and the certificate chain.
