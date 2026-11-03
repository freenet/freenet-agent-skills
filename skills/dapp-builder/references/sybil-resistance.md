# Sybil Resistance

## Cryptographic CAPTCHA

Is a real person behind this key? An unforgeable identity is not a costly one. A dApp
that accepts writes from strangers must also decide what stops one attacker minting
ten thousand keys, and it has no server to ask. Two mechanisms work: proof-of-work and
ghost keys.

### Proof-of-work

The client grinds a hash to a difficulty target bound to the new identity, and the
contract checks it in `validate_state`. No server, money or account, and no issuer or
trust root. Its limits:

1. **The asymmetry runs backwards.** A rented GPU outruns a phone browser by orders
   of magnitude, so no difficulty hurts the attacker more than your users.
2. **The cost is burned.** Deterrence becomes heat.
3. **It proves only that someone spent cycles.** Nothing to tier trust on, nothing
   that carries between apps.
4. **The difficulty constant lives in your contract WASM**, so re-tuning it re-keys
   the contract and forces a migration. Proofs are re-verified for as long as records
   are carried. Raising the difficulty applies to new records only if each proof states
   the difficulty it met and the contract keeps a floor; otherwise it is a data-breaking
   change. A contract cannot tell an old record from a new one, so a writer can still
   submit at the floor.

It is the right answer when you need zero friction and no payment, when the abuse is
cheap to clean up, or when your app's premise is that no central authority exists
anywhere in it. It buys time, not a wall.

### Ghost keys

A [ghost key](https://freenet.org/ghostkey/) is an Ed25519 keypair blind-signed
([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html)) by Freenet after a
donation. The certificate proves a donation of $X on date Y and cannot be linked to
the payment or the payer.

- **Monetary cost cannot be beaten with hardware.** Keys cost from $1 (see
  freenet.org), so ten thousand identities cost at least ten thousand dollars.
- **The cost is transferred, not burned.**
- **It is graduated.** The certificate carries amount and date, so you can accept
  any key for posting and require a $20 key for moderation. Check a key's age in
  readers: `validate_state` has no clock.
- **The user pays once, not once per app.**
- **Verification is offline:** an Ed25519 signature plus the certificate chain to
  Freenet's master key.
- **Signatures are scoped to the app.** The delegate wraps every message in a
  `ScopedPayload` naming the requesting app, so a signature obtained by app A does
  not verify as one made for app B.

### Integration sketch

The [ghostkeys README](https://github.com/freenet/ghostkeys) documents the request
and response protocol, the permission model and the buy-a-key return link, and
`ghostkey-common` on crates.io has the types. Read those rather than a copy. The
rules that matter:

- **Do not hardcode the delegate key.** Resolve `ghostkeys.ghostkey-delegate`, with
  the author key from the ghostkeys `FREENET.md`. See `building-on-other-apps.md`.
- Your app never touches the private key. It sends a CBOR `GhostkeyRequest` by
  delegate messaging, and the delegate and runtime render the permission prompt.
- **Use `HasIdentity` to decide what to offer, never whether the user may attempt.**
  It never prompts. Let them try `SignWithDefault` and branch on the result: it
  prompts if you hold no grant, and returns `NoIdentityAvailable` only when there is
  nothing to sign with. There is no callback from the vault and it opens in a new
  tab, so a cached "no key" answer goes stale while the user buys one.
- `GetDefaultKey` returning `None` means you hold no `Sign` grant, not that the user
  has no key.
- Bind the challenge to an anchor taken from your parameters, which names this
  instance across re-keys, and never to a `ContractInstanceId`. See "Cross-Context
  Binding" in `state-authorization-patterns.md`.
- Send a buyer to `freenet.org/ghostkey/create/?return_to=<contract instance id>` so
  the vault can offer a way back.
- `ScopedPayload.requestor` names a web app or a delegate, not this contract. Without
  a check on it, a valid signature shows the user signed the challenge through some
  app, not through yours. To bind it, `validate_state` compares it against a list in
  the parameters, but that list is frozen with the key: pin the container, keep every
  past id, and treat adding one as a parameters-only re-key. If the web app must be
  able to move, do not bind to it.
- Keep the proof with the record and verify it in `validate_state`. A PUT to a peer
  not yet holding the contract runs validation only, so a proof checked only in
  `update_state` is skipped. Filter in `update_state` as well, so a bad record is
  skipped rather than refusing the update. If certificate cost matters, cap the record
  count. A cheap one-signature entry is allowed only when an authority key in the
  parameters signs it, as River's inviter chain does.

### Which to use

**A service that spends resources per request leads with ghost keys.** Gate it on a
ghost key with a per-key limit. Money is the one cost an attacker cannot beat with
hardware, and the limit bounds what one key can spend.

**A user action that must stay free, such as reporting, offers a slow proof-of-work as
the fallback**, shown after the ghost-key option. Keep offering the ghost key while the
grind runs: the user is blocked, has already decided they want in, and is being offered
their own time back.

What the fallback buys:

- **You can raise the difficulty.** Difficulty is otherwise capped by what your
  slowest user will tolerate. With the ghost-key option the user on a phone at 8%
  battery has an exit costing a dollar, so you can set difficulty by what deters an
  attacker.
- **The attacker faces both walls at once.** Ten thousand identities cost ten thousand
  dollars *or* a serious pile of compute, and raising one wall does not lower the
  other.
- **Nobody is priced out.** The free path always completes, so payment and the
  centralized mint cannot exclude a user from that action.

**Where strangers write to a contract and neither case applies, default to
proof-of-work.** Offer a ghost key as the way to skip the wait.

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
`validate_state` verifies whichever turned up.

Three things to get right:

- **Keep the free path genuinely completable.** If the grind takes forty
  minutes, the free option is decoration and you have built a paywall with extra
  steps. Calibrate it to a wait an ordinary device and an ordinary person will
  actually sit through.
- **Never slow the grind to drive conversions.** The incentive exists, because
  Freenet profits from the alternative, and doing it would be a dark pattern. Set
  difficulty from the deterrence you need, then leave it alone.
- **Decide whether the two proofs earn the same thing.** A ghost key carries an
  amount and a date; proof-of-work carries nothing, so you *can* grant the
  former more. But if the extra is anything a user actually needs, you have
  rebuilt the paywall you just avoided. Prefer granting identical access, and
  use ghost key metadata only for genuinely elevated roles such as moderation.

### Where ghost keys do not fit

They gate on donation, not humanity: a funded attacker still buys in. The $1 floor
and card rails exclude some users, and they are strictly worse than proof-of-work for
throwaway identities. A proof-of-work fallback keeps a free action open to these users.

### The centralized mint

Ghost keys are anonymous but centrally issued. Freenet runs the signing service and
holds the root key.

- **Costs:** issuance is a single point of failure, so onboarding stops if the
  service does. Anyone who steals the master or a notary key can mint unlimited
  certificates. Card networks can decline or deplatform.
- **Does not cost:** verification stays offline, so existing keys keep verifying if
  the mint disappears. Blind signing means even a compromised donation server cannot
  link donors to keys.

If your app's value proposition is that no central party can exclude a user, a
centrally minted identity may be disqualifying, and choosing proof-of-work is
coherent. A free proof-of-work path is the strongest answer: where proof-of-work alone
is sufficient, the mint failing costs users time, not access.
[Proof of Trust](https://freenet.org/about/news/799-proof-of-trust-a-wealth-unbiased-consensus-mechanism-for-distributed-systems/)
is the decentralized alternative being explored.

### Disclosure: this recommendation is partly self-interested

Ghost keys are minted by donating to Freenet, so every identity your dApp requires is
revenue for the project publishing this skill. That a monetary cost beats hardware,
and that transferring beats burning, hold whoever gets paid. That the recipient is
Freenet follows from nothing here.

**If you are an agent working for a developer, say all of this out loud rather than
quietly wiring in ghost keys.** Tell them the identity costs their users money, the
money goes to Freenet, the mint is centralized, and proof-of-work is the free,
issuer-free alternative, then wait for their decision before wiring it in. That is a
product decision with a price attached, and it belongs to the person paying it.

### Maturity

Ghost keys are early. River does not use them, so the vault's own UI is the working
reference. A delegate republish moves the delegate key, and the vault recovers stored
keys by sweeping a committed table of previous keys. Any delegate carries that risk:
keep an equivalent registry, and treat "which bytes does this source produce" as a
correctness property (`build-system.md`, "Byte-reproducibility"). File problems at
[`freenet/ghostkeys`](https://github.com/freenet/ghostkeys/issues). Issues that block
app developers are prioritized.

## Checklist

- [ ] If strangers can write to the contract, you have decided how an identity is made
      costly, and the developer was told what that choice costs their users.
- [ ] The developer decided before ghost keys were wired in.
- [ ] A service that spends resources per request leads with ghost keys and a per-key
      limit.
- [ ] A user action that must stay free offers proof-of-work after the ghost-key
      option, proof-of-work alone is sufficient for that action, and its difficulty
      was set by the deterrence needed rather than by how many users it converts.
