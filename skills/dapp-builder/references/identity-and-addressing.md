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

## Cross-references

- `contract-patterns.md` — "Contract Parameters" and "Contract WASM Upgrade &
  State Migration".
- `state-authorization-patterns.md` — verifying signed state against the key,
  cross-context binding, and per-context identity (River's pattern of
  context-scoped keys, where a user deliberately has *no* global address — the
  opposite design choice to this doc, valid when unlinkability matters more than
  a stable handle).
- `delegate-patterns.md` — where the user's private keys are actually stored.
