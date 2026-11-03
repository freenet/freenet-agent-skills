# State Authorization & Replay Protection Patterns

Patterns for contract state contributed by several parties, or controlled by one party and read by others. Every piece of data in contract state must be cryptographically authorized.

## Authentication Patterns

Every field in contract state must be authorized somehow. Two patterns cover most cases:

### Per-Item Signatures

Use when many similar items are contributed by different parties.

```rust
pub struct Inbox {
    /// Each message independently signed by its sender.
    pub messages: Vec<InboxMessage>,
}

pub struct InboxMessage {
    pub sender: MemberId,
    pub timestamp: u64,
    pub ciphertext: Vec<u8>,
    pub signature: Signature,  // sender signs canonical bytes of the message
    pub room_owner: MemberId,  // names the room of the membership claim
}
```

Used for: messages signed by senders, members signed by inviters, votes signed by voters.

### Bundled Signature (Configuration Pattern)

Use when one party controls a section of state. Wrap the whole section in an `Authorized*` envelope; the wrapping signature implicitly authorizes everything inside, including the order of contained lists.

```rust
pub struct Inbox {
    pub messages: Vec<InboxMessage>,
    /// Recipient-controlled section. Bundled signature covers the
    /// whole RecipientState, including order of any contained Vecs.
    pub recipient_state: Option<AuthorizedRecipientState>,
}

pub struct AuthorizedRecipientState {
    pub state: RecipientState,
    /// Recipient's signature over canonical bytes of `state`.
    pub signature: Signature,
}

pub struct RecipientState {
    pub version: u64,             // monotonic, replay protection
    pub purged: Vec<u32>,          // FIFO order matters; sig covers it
    // Future fields go here, with BOTH #[serde(default)] and
    // skip_serializing_if -- the signature covers these bytes, so a field
    // that encodes as null when absent invalidates every existing signature.
}
```

Used for: River's room `Configuration`, a mailbox's recipient-controlled state, owner-managed metadata.

Adding a new field to a bundled-signed struct doesn't require new per-field auth — the wrapping signature covers it. It does require care with the *encoding*: `#[serde(default)]` alone lets old bytes decode, but re-encoding an existing record now emits the new key and invalidates the signature over it. Add `skip_serializing_if` as well; see "`#[serde(default)]` is not enough when a signature covers the encoding" under Wire-Format Stability, which is exactly this case.

### A Symmetric Key Cannot Establish Authorship

If two parties share a symmetric key — a conversation key, a channel key, a
derived session secret — **decryption proves membership, never authorship.**
Both sides hold the same key by necessity, so a `direction: FromBuyer` field
inside the ciphertext, a sender label, an ordering convention, are all things the
*other* party can write; a UI that renders one side's messages differently on the
strength of such a label is showing the reader something the counterparty chose.
Anything whose authenticity matters carries its own signature under a key only
the claimed author holds. This is easy to lose sight of once a payload is
encrypted, because encryption feels like it settled something — it settled
confidentiality.

### The Mistake to Avoid

Storing **bare derived/cached fields** with no corresponding authorization. Looks fine because update paths populate them legitimately, but a peer can PUT arbitrary state through `validate_state` and the bare fields won't be verified against anything.

```rust
// BAD: bare fields a malicious PUT can set arbitrarily.
pub struct Inbox {
    pub messages: Vec<InboxMessage>,    // OK — per-item signatures
    pub purged: VecDeque<PurgedId>,     // BAD — no authorization
    pub last_purge_counter: u64,         // BAD — no authorization
}
```

Either store the originating signed events (e.g., a log of `AuthorizedPurge` actions) and derive the cache view at validation time, OR bundle into a signed envelope (`AuthorizedRecipientState`) that authorizes the layout wholesale.

## Replay Protection

### Monotonic Counter

For replaceable signed envelopes (Configuration, RecipientState). Each new version must have `counter > previous`. A replayed older signed state has no effect: the merge keeps the higher version.

```rust
pub struct RecipientState {
    /// Strictly increasing per-recipient. Each new state must have
    /// version > the previous one's.
    pub version: u64,
    // ...
}
```

Counter goes in the bytes covered by the signature, so signatures are bound to a specific version. Old signed states cannot be replayed because the contract knows the current version is higher.

### Tombstones

For "forgotten but must not return" state. River's bans are suppression under a cap, not removal tombstones: while the ban is held, a banned member's record is dropped on every merge, including after a re-invitation. A mailbox's purged list works the same way: while the entry is held, a purged message can't be re-submitted.

```rust
pub struct RecipientState {
    pub version: u64,
    /// Truncated fast_hash of purged message signatures.
    /// AppendMessages whose hash matches an entry here are dropped.
    pub purged: Vec<u32>,
}
```

A list suppressing something you can afford to see again, like this one, can be bounded. The recipient (or party authorizing tombstones) is responsible for FIFO eviction when full.

That eviction is arrival-ordered, which is legal here only because no peer
re-derives the order: `RecipientState` is a single-writer envelope the recipient
re-signs in full, and the merge is last-writer-wins on the whole envelope, so
peers copy the recipient's list. Losing the suppression is what a successful
eviction costs, and that is the risk this design accepts deliberately. If the
merge unions `purged` instead, every evicted tombstone returns from any peer
holding an older copy, and the list is unbounded in practice.

**A removal tombstone must never be evicted, whichever merge the list uses.** In
a last-writer-wins envelope, eviction lets the removed item return from a peer
holding older state. In a unioned list, the evicted tombstone itself returns and
the list never shrinks. Size the state to hold every removal, or shard.

### Removing Illegal Material

Any system showing content other people published needs a way to identify and remove illegal
material, or it risks delisting from Atlas and having its links banned from the Freenet Official
River room, for most dApps the main ways new users find them. This matters most for images and
video, where the worst material (child sexual abuse material above all) is found. An app letting
strangers publish media needs this working before launch.

**Identifying it.** Which approach fits depends on the service, so choose with the developer:

- **Curated publishing:** the author or a small set of trusted keys are the check. Only fits a
  curated site, not one open to strangers.
- **Moderators who watch the content** and remove what breaks the rules. River rooms rely on
  this: the owner, anyone above a member in the invite chain, or a deputy can ban that member.
- **User reports:** a Report action sending the item's id and a reason to whoever moderates,
  usually through a report-inbox contract. Suits open services. A report inbox nobody reads is
  worse than none, because users believe they have told someone.

**Removing it.** Where the moderator's key can write to the contract holding the content, it
tombstones the item: keep a hash of the media bytes, drop the bytes, and drop any item with that
hash on every later merge. The tombstone hashes the media bytes alone, unlike a Record Identity
id (`contract-patterns.md`), which covers every term of the record, so the same bytes cannot
return inside a new record. If the item is simply deleted, the next merge with a peer holding
older state brings it back. Never evict a removal tombstone (see "Tombstones"). Design this in
from v1: adding it after launch means a contract upgrade.

Where the moderator cannot write there (content in user-owned contracts, an open index, or a
separate asset contract), publish an author-signed denylist contract the UI reads, and filter
before rendering.

Be accurate with users: removal drops the item from current state and from every UI honouring
it, but does not erase copies peers already hold. Say "removed", not "deleted from the network".

**Consider gating reports with ghost keys.** Junk reports bury real ones, and mass false reports
are a cheap way to take down legitimate content. A ghost-key signature on each report makes
volume cost money that better hardware does not reduce, keeps the reporter anonymous, and lets
the moderator weigh reports by donation amount and key age and ignore a key that has filed
reports in bad faith. Keep the signature with the report and verify it in `validate_state`,
because a PUT to a peer not yet holding the contract runs validation only, and filter in
`update_state` so a bad report is skipped, not refused (`sybil-resistance.md` → "Integration
sketch"). This is a suggestion: reporting illegal
material should not cost money, so offer slow proof-of-work as the free fallback
(`sybil-resistance.md` → "Cryptographic CAPTCHA") and relay the caveats there.

### Cross-Context Binding

Bind an anchor in the bytes covered by every signature. Without one, a signed payload valid for inbox-A can be replayed against inbox-B if both share enough state structure.

The anchor must name this instance across re-keys, and the verifier takes it from parameters, never from the record. If the record also carries it as a field, the verifier compares that field against the parameters.

- A signer's own key never counts: Ed25519 already binds it.
- An owner key counts only if the parameters are that key alone. An app-chosen id in the parameters is the general form.
- Never bind a `ContractInstanceId`. It moves on every re-key, so every record would fail verification under the successor.

```rust
pub fn build_signed_payload_bytes(
    sender: MemberId,
    recipient_vk: &VerifyingKey,  // <-- anchor: from parameters, binds to this inbox
    room_owner: MemberId,         // <-- binds to membership claim
    timestamp: u64,
    ciphertext: &[u8],
) -> Vec<u8> {
    // ... canonical layout ...
}
```

Cheap; eliminates an entire class of replay attacks.

### A Value One Party Supplies May Only Decide the Fate of That Party's Own Records

Ranking on a writer-supplied value is fine, and the rest of this skill
recommends it: the monotonic `version` above is writer-supplied, so is the
author's signed timestamp used to order messages, so is the version in
last-writer-wins. What makes those safe is not the signature — the value is
authentically theirs, and the point is that they *chose* it. What makes them
safe is that the value only ever decides the fate of the supplier's **own**
record: an owner's `version` replaces the owner's previous configuration, and
nobody else's.

The rule is the boundary, not the value:

> A value one party supplies may decide **which of that party's records
> survives**. It must never decide **whose records get discarded**.

Three violations of it turned up in one app in one day:

- **Retention driven by an unauthenticated timestamp.** A capped mailbox
  evicting its oldest entry by a sender-supplied `sent_at`: one message stamped
  far in the future evicts every real message behind it. One forged message
  emptied a mailbox.
- **A merge tie-break steered by submission order.** "Whichever claim arrived
  first" is a property of the network, not of the data, so the counterparty can
  influence it — and it breaks order-independence besides, which is a merge-law
  violation in its own right.
- **An eviction ranking reading a value out of an imported blob.** A timestamp
  parsed from a backup string that whoever handed the user the backup wrote is
  not a fact your app established.

Ways to stay on the right side of it:

- **Cap per author, not globally, and rank each author's records only among
  their own.** A forged value then costs its own author and reaches nobody
  else's entries, however hard it is ground. This is usually the whole fix. Note
  that the bound itself still has to be enforced order-independently — see State
  Size Budget, a separate requirement that is easy to satisfy while breaking
  this one, and vice versa.
- **Tie-break on a deterministic function of the record's content** (a hash, or
  the signature bytes as in the last-writer-wins example in
  `contract-patterns.md`) rather than on anything about its arrival.
- **Where you must rank across parties, use an attestation signed by the party
  being ranked *against*.**

This is the general form of "a client-supplied timestamp must not be an eviction
key" under Time Handling. It is not really about clocks, and signing the
timestamp does not fix it.

## Signed-Payload Hygiene

### Prefer Manual Canonical Byte Layout Over CBOR/Serde

CBOR is **not canonical by default**. Two serializers can produce different bytes for the same logical value (e.g., integer encoding modes, map-key ordering). A malicious peer can craft a signed-but-malformed payload that re-encodes differently, breaking signature verification or enabling replay.

Use a fixed manual byte layout for the bytes that signatures cover:

```rust
pub fn build_signed_payload_bytes(...) -> Vec<u8> {
    let ct_len: u32 = ciphertext.len().try_into().expect("ct < 4 GiB");
    let mut out = Vec::with_capacity(...);
    out.extend_from_slice(&sender.to_le_bytes());        // fixed-length
    out.extend_from_slice(recipient_vk.as_bytes());       // 32 bytes
    out.extend_from_slice(&room_owner.to_le_bytes());     // fixed-length
    out.extend_from_slice(&timestamp.to_le_bytes());      // 8 bytes
    out.extend_from_slice(&ct_len.to_le_bytes());         // 4 bytes
    out.extend_from_slice(ciphertext);                    // variable, length-prefixed
    out
}
```

State itself can still use CBOR (via `ciborium`) — only the bytes that go through signature verification need the manual layout.

### Length-Prefix Variable-Length Fields

Two adjacent variable-length fields with no prefix can be re-split: `("ab", "c")`
and `("a", "bc")` sign the same bytes, so one signature covers two different
records. Always `len_le_u32 || bytes`.

### Bind All Relevant Context

The signed bytes should commit to:

- **Sender identity** (cryptographically redundant with using sender's VK to verify, but explicit binding removes ambiguity and matches River's other signed structs).
- **Instance anchor** from the parameters, never a `ContractInstanceId` (prevents cross-instance replay; see "Cross-Context Binding").
- **Logical scope** (e.g., `room_owner`, which prevents membership-claim swap).
- **Timestamp** (replay window for new admissions).
- **Content** (the actual payload).

If a field is in state and matters, it should be in the signed bytes.

### Hard-Code Expected Hex in Wire-Format Round-Trip Tests

A test that round-trips its own output catches nothing — `serialize → deserialize → equals input` always passes regardless of encoding changes. Paste the expected bytes as a hex constant, assert against it, and round-trip as well to catch deserializer asymmetry. This catches accidental serde attribute drift, ciborium version bumps that change canonical output, and field reordering.

## Time Handling

### Contracts Must Not Read the Host Clock

`freenet_stdlib::time::now()` (the `freenet_time::__frnt__time__utc_now` import)
is deprecated for contracts. `update_state` must be a function of its inputs,
and a clock read makes it a function of the evaluating peer: two peers whose
clocks differ can produce different states from the same delta, and neither is
wrong. A node warns when it loads a contract that imports the clock, and
`fdev verify-merge` reports a `host_clock_import` code diagnostic, which never
fails the command. stdlib has no deprecation warning, so fdev is the check. The
plan (freenet-core#5465) is that a call will trap; the contract still loads, so
one that imports the symbol without reaching it needs no rebuild or re-key.

**Delegates are unaffected.** A delegate holds private per-node state, is never
replicated, and has no merge laws.

### Instead: A Signed Timestamp in State, Checked Only for Monotonicity

Put the timestamp **inside the state, in the client-signed payload**, and have the contract check only that it moves forward:

```rust
// timestamp_ms is part of the signed payload, so every peer evaluating this
// update sees the same value and reaches the same state. A state that is not
// newer is ignored rather than refused: returning Err here would make
// merge(A, A) and merge(newer, older) fail. Equal timestamps are broken by the
// whole state's bytes, so the result does not depend on arrival order even if
// some field is not covered by the signature.
let incoming_wins = (new_beacon.timestamp_ms, incoming_state.as_ref())
    > (current.timestamp_ms, current_state.as_ref());
let next = if incoming_wins { incoming_state } else { current_state };
Ok(UpdateModification::valid(next))
```

**Be clear about what this loses.** A client-supplied timestamp is an *untrusted hint*. It is fine for ordering and ranking, and it cannot do the anti-grief job a host-clock skew check was doing, because the party asserting the time is the party being checked — set it far in the future and the check passes. Swapping in a client timestamp while still treating it as authoritative moves the bug rather than fixing it.

The two shapes that show up in practice:

- **Anti-grief on a per-author log** (the common case): cap the log by *count*, or key it on a monotonic counter. A client-supplied timestamp must not decide whose records are evicted; within one author's own records it may, because an author who future-dates only displaces their own entries.
- **Capability expiry** (rare, and the genuinely hard one): there is no clean in-contract substitute, because the party asserting the time is the party being checked. The available shapes are a sequence number plus a revocation record, or enforcing expiry outside the contract.

**The sharp edge in the usual replacement.** The obvious substitute for a retention window is to derive it from the state's own newest timestamp — a logical clock. That has a real failure mode: one future-dated entry sets the reference permanently, degrading every peer's view from then on with nothing to heal it, where a wall-clock rule would have recovered on its own once real time caught up. If you take this route, bound how far the reference may advance in one update, or use a count cap instead. The migration off the clock is not free; budget for it.

### Skew Checks Against the Host Clock Are Out, Both Directions

**Future skew.** Rejecting or pruning a message timestamped ahead of the host
clock makes the result a function of which peer evaluated it. Handing the
contract an operation timestamp does not rescue this, because the originator
sets that value. The check does not belong in the merge.

**Past skew, and any rule whose truth expires.** Never put a time-derived
rejection in `validate_state`: it makes state you already hold retroactively
invalid. Thirty days after a mailbox's oldest message arrives, the mailbox stops
validating. Peers refuse it and every change to it fails, because
`validate_state` also gates the state `update_state` returns. An update that
drops the message lands, but the next-oldest crosses the window soon after, so
the freeze re-arms. Every peer's copy aged the same way, so no valid donor state
exists. Worse, when a merge fails on a locally-invalid state, the node replaces it
with any valid full state it is sent (freenet-core#3109), so the state can be taken
away.

Replay protection for old messages uses signature-based dedup and tombstones,
never a time window in `validate_state`.

### On Native Targets `time::now()` Is Undefined Behaviour

Delegates may read the clock, but stdlib's non-WASM stub leaves the value
uninitialized and then `assume_init()`s it, so a host-side test that calls
`now()` reads uninitialized memory. Gate the call on
`cfg(target_family = "wasm")` and give native tests an override.

## Related-Contracts Mechanism

### `validate_state` Can Read Other Contracts

```rust
fn validate_state(
    parameters: Parameters<'static>,
    state: State<'static>,
    related: RelatedContracts<'static>,
) -> Result<ValidateResult, ContractError> {
    // First pass: if the room's contract isn't in `related`, request it:
    if let Some(missing_id) = self.find_missing_related(&state, &related) {
        return Ok(ValidateResult::RequestRelated(vec![missing_id]));
    }
    // Second pass: related is populated; check membership:
    self.check_membership(&state, &related)
}
```

Host fetches the requested contracts (locally first, then network) and re-invokes `validate_state` with `related` populated.

The contract id in `find_missing_related` is one this WASM derives, from the entry's `room_owner` and the room contract's code hash built into it. That id moves when the room contract re-keys, and entries that name the old one stop resolving, so where that matters carry a signed attestation in the entry instead (see "Never Gate an Item's Validity on a Value That Can Decrease").

### Limits

- **Depth = 1.** A contract returning `RequestRelated` on the second pass is a logic error — host rejects.
- **Max 10 related contracts per request** (`MAX_RELATED_CONTRACTS_PER_REQUEST`). Give the state a *structural* bound — fixed typed slots rather than an open-ended list other parties can extend — so an eleventh reference cannot arise. A count cap is a poor fallback here, because whichever reference truncation drops is one the contract needed, and the limit is not yours to enforce anyway — the **host** rejects the request outright when a contract asks for more than ten, so the operation fails rather than your `validate_state` returning `Invalid`. Where the set of things to consult is genuinely open-ended, replace the live read with a signed attestation carried in the entry — see "Never Gate an Item's Validity on a Value That Can Decrease" — so there is nothing to fetch and no limit to hit.
- **10s fetch timeout per request.** Multiple bogus references multiply the latency cost.
- A related fetch that times out can wedge an UPDATE merge (freenet-core#4077).
- Clients send `UpdateData::RelatedStateAndDelta`. Bare `RelatedState` and `RelatedDelta` are
  rejected on `ContractRequest::Update`; they are reserved for the runtime, which surfaces
  `RelatedState` to your WASM itself.
- `#[composable]` has no inter-contract awareness, so cross-contract dependencies are
  hand-rolled.

### Checking a Contract That Reads Related State

`fdev verify-merge --state` runs with no related state, so a contract that requests it comes
back 100% inconclusive and exits 0, which reads as a clean bill when skimmed. Use `--bundle`
on a capture holding related state, read any `bundle note:` line on stderr (capture records
there when it refused related state), count the explicit verdicts, and treat inconclusive as
not a pass. Exit code 4 means violations were found.

The verifier never fetches related state; it replays what the bundle carries, and capture keeps
only the most recently observed state per related contract. A defect that needs an older
related state gets no verdict, and a green run does not exercise production's depth=1 fetch.

### Requesting Related State From `update_state`

`update_state` takes no `related` parameter, but it is not confined to `validate_state` for cross-contract reads: return `UpdateModification::requires(vec![...])` and the host resolves those contracts — local state store first, network only as fallback — and re-invokes `update_state` with the results supplied as `UpdateData::RelatedState` entries.

The host also validates the state `update_state` returns before committing it,
so validate remains the backstop — and note what that costs when your two
functions disagree about a bound, since the merge is then refused rather than
corrected: see "Bound It In `update_state`" under State Size Budget.

**Prefer the `update_state` route where either would work.** Better still, fold
the related fact into your own state as it arrives and gate on your own state:
validity stays a function of your own inputs, so peers cannot disagree, and the
fact sits inside the merge where the laws check it.

### Never Gate an Item's Validity on a Value That Can Decrease

`validate_state` must reach the same verdict on the same bytes forever. That is
automatic for a check confined to the bytes in front of it — `balance >= 0`, "every
entry carries a valid signature", "the counter never goes backwards" are all fine,
and a balance being *spendable* does not make it unusable as a well-formedness
check. (A bytes-confined check can still be one your own `update_state` is able
to violate, which freezes the contract; that is a separate hazard, under "Bound It
In `update_state`".) The hazard here is narrower and easy to miss: **an already-accepted item whose
validity depends on a quantity that can later shrink.** Two shapes do it.

1. **A value read live from another contract** (the `RelatedContracts` mechanism
   above). A listing gated on the seller's reputation "standing" is accepted at
   standing 80 and rejected once complaints drive standing to 40 — the listing's
   own bytes never changed. Peers that validate at different times reach different
   verdicts, permanently, and no merge reconciles them.
2. **A mutable aggregate elsewhere in the same state.** "This entry is valid
   because `total_stake >= X`" has the same defect if a later merge can reduce
   `total_stake`: the entry was valid when merged and is not any more.

The fix in both cases is to move the shrinking quantity out of the validity rule,
not to bound it. Compute standing in *readers* — the UI ranks, filters or warns on
it — and leave the contract's validity rule to signatures and monotonic facts. If
the check must be in the contract, bind it at write time to something immutable:
have the reputation contract's owner sign a "standing was >= 50 on <nonce>"
attestation and validate *that signature*, which stays true forever.

## Wire-Format Stability

### Forever-Compat Once Shipped

Once any user has state under your contract, the encoding is locked. You cannot reorder fields, rename fields, change tuple ↔ struct, or change CBOR encoder behavior without breaking that user's state.

### Use `#[serde(default)]` on Every Added Field

Adding a new field to existing state types should be backwards-compatible: old states should still deserialize, with the new field defaulted.

`#[serde(default)]` doesn't apply to fields that are required for security (e.g., the contract should never silently accept a message with a defaulted-to-zero `signature`). For those, omit the default and let deserialization fail loudly.

#### `#[serde(default)]` is not enough when a signature covers the encoding

`#[serde(default)]` fixes *reading* old bytes. It does nothing about *writing*
them back, and that is what breaks signatures. Add an `Option` field to a struct
whose serialized form is the signed payload, and re-encoding an existing record
now emits the new key with a `null` value: ciborium writes a definite-length
map, so `map(13)` becomes `map(14)` and **every signature ever made over that
type stops verifying** — including on records already published, which have no
route back to a signing key.

```rust
#[derive(Serialize, Deserialize)]
pub struct SignedTerms {
    // ...
    /// Added in v2. `skip_serializing_if` keeps a record that predates the
    /// field byte-identical to what its author signed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payout_address: Option<Address>,
}
```

Two things to get right beyond the attribute:

- **`skip_serializing_if` is a promise about the absent case only.** A record
  that *does* carry the field encodes at map(14) and must be signed that way, so
  the two shapes coexist forever. That is fine; what is not fine is a later
  change that makes the field non-optional, which silently re-breaks every
  pre-v2 record.
- **Test it with a hand-written byte literal of the OLD shape.** Building a
  modern struct with the field set to `None` and serializing it proves only that
  today's code agrees with itself — it is exactly the encoding path you are
  trying to check. Paste the old bytes as a hex constant, deserialize *those*,
  and assert the signature still verifies. Same reasoning as the hard-coded
  expected hex above, one step earlier in the pipeline.

### Never Ship a State Version That Skips Verification

One step beyond defaulting an auth field. A defaulted auth field weakens one
check; a *version* whose decode path does not verify signatures removes the check
entirely, and the version tag is attacker-chosen. Anything that can write the
unverified version — a legacy `V0` kept "for old data", a `Draft` variant, an
`Unsigned` shape used by a test fixture or a migration — bypasses verification for
every field at once, because verification is now conditional on a byte the writer
supplies.

```rust
// BAD: the writer picks the arm that verifies nothing.
enum Item {
    V0(UnsignedItem),   // "legacy, we'll drop it later"  <-- attacker's choice
    V1(SignedItem),
}
```

If old unsigned data genuinely exists, migrate it *behind* a verified wrapper — the
migrating writer signs it, so the unverified shape never appears on the wire — and
delete the variant. Never leave a decode path in which "which checks run" depends on
untrusted input. A test asserting `V1` rejects tampering says nothing about `V0`.

## State Size Budget

The host enforces `MAX_STATE_SIZE = 50 MiB` as a hard correctness backstop — a PUT/UPDATE that would exceed it is rejected outright. Plan caps so worst-case state fits with margin:

- Per-item cap × max-items + envelope overhead ≤ 50 MiB.
- Including auth metadata (signatures are 64 bytes, VKs 32 bytes, etc.).
- Including any tombstone/log structures.

**A count cap is not a size bound.** `MAX_ITEMS = 1000` bounds nothing if an item
can be any size, and the other side chooses the size. A count cap times a
per-item size cap bounds bytes and stays convergent, because the per-item cap is
a property of the entry. Multiply the worst case and check the product. Budgeting
bytes directly with a running total is harder than it looks; "Bound It In
`update_state`" below has the counterexample.

**Design target: stay well under 4 MB per instance, regardless of the 50 MiB cap.** The cap is about correctness, not user experience — a GET transfers the entire state before the UI can render anything, so state size is felt directly as load latency, and it's the wire-transfer floor under the streaming behavior described in `ui-patterns.md` → "Large state handling". If a kind of data can grow without bound (message history, uploaded files, a list that only grows), shard by the natural unit of write concurrency — one contract per room, per user, per time-window, per shard-key — so each instance's state stays small no matter how large the dataset gets in aggregate. Treat a multi-MB instance as a signal to split the data model, not to compress harder or budget more cap headroom.

Large *binary* assets served by the UI (audio, video, images, user uploads) are a special case of the same sharding advice, not a new problem: give the asset its own contract instance instead of embedding it in the webapp bundle's state, and reference it from the UI by key. See `ui-patterns.md` → "Large Binary Assets: Their Own Contract, Not the Webapp Bundle" for the same-origin fetch mechanism that makes this work under the gateway CSP.

### Bound It In `update_state`, Never Only In `validate_state`

Having settled on a cap — bytes, items, tombstones, whatever it bounds — decide
where it is enforced.

> **`update_state` must never be able to produce a state its own
> `validate_state` would refuse.** A merge whose output your own validator
> rejects is an update that cannot land. A bound checked only in
> `validate_state` is a bound your merge does not know about, so the day it
> binds, every write that would cross it is refused — indefinitely, if nothing
> in the contract ever shrinks the state.

Two things follow:

- **Give the contract something that shrinks.** What is refused is the merge
  whose output exceeds the cap, so a purge, a removing tombstone or a re-signed
  smaller envelope lands normally and lifts the freeze. Without one the freeze
  is permanent.
- **Nothing is corrupted.** The stored state is valid and propagates, and peers
  agree on it. The contract is full. A smaller state from a peer does not rescue
  it unless your merge is willing to drop entries.

Two rules about how the merge should do the bounding:

- **The surviving set must be a function of the entry set, not of arrival
  order.** "Evict until it fits" and "refuse the eleventh" decide which entries
  survive from the order they arrived in, so two peers merging the same entries
  in different orders keep different ones and never converge — a merge-law
  violation traded for a bound. The straightforward convergent form is a **count
  cap: sort by a key the entries themselves determine, keep the N smallest**,
  which is order-independent because an entry among the N smallest of `A ∪ B` is
  among the N smallest of whichever side it came from. The key must be unique —
  tie-break on a digest of the whole entry. Pair it with a **per-item size cap**
  and you have a byte bound too, since a per-item cap is a property of the entry.

  A running byte budget over the sorted list looks equivalent and is not, at
  least in the form that stops at the first entry which does not fit: sorting
  `p < q < r` with sizes 9, 2, 1 against a budget of 10, `{p,q}` truncates to
  `{p}` and `{r}` stays `{r}`, so merging those gives `{p, r}` — while merging
  `{p,q}` with `{r}` directly gives `{p}`. Not associative. Skipping the
  oversized entry and carrying on survives *this* example, which is the point: a
  byte budget has more than one plausible reading and each needs its own check.
- **Rank a party's records only against that party's own** (see "A Value One
  Party Supplies…"). A content-derived key does not escape this: a writer can
  grind content until its digest sorts where they want. If you need a global
  bound across mutually-untrusting writers, shard instead: one contract instance
  per writer, room or time-window.

The past-skew check under Time Handling is the neighbouring failure, reached by
expiry rather than by accumulation, and it ends worse.

For the node's call graph, read
`crates/core/src/contract/executor/runtime/{executor_impl,contract_ops}.rs`.

## Per-Context Identity Considerations

If your dApp uses per-context signing keys (River's pattern: the inviter
generates a fresh keypair for each member, scoped to one room), a user has one
identity per context and no global identity. Signed cross-context references must
carry the context id, and anything addressing "this user" must name the context.
This buys cross-context unlinkability, at the cost of needing the context to look
up a key.
