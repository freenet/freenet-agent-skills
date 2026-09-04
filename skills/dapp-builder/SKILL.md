---
name: dapp-builder
description: Build and maintain decentralized applications on Freenet using river as a template. Guides through designing contracts (shared state), delegates (private state), and UI, and through upgrading a live dApp safely. Use when user wants to create a new Freenet dApp, design contract state, implement delegates, build a Freenet-connected UI, OR upgrade an existing dApp — bump freenet-stdlib, ship a new contract/delegate version (v2), fix a bug that re-keys the WASM, or migrate state across a contract/delegate key change without breaking invites or losing data. Also use when INTEGRATING with a contract or delegate published by another app — reading another project's contract state, depending on a platform delegate, or deciding how to address someone else's artifact so it survives their re-keys.
license: LGPL-3.0
---

# Freenet Decentralized Application Builder

Build decentralized applications on Freenet following the architecture patterns established in River (decentralized chat).

## How Freenet Applications Work

Freenet is a platform for building decentralized applications that run without centralized servers. Apps store and exchange data through a global, peer-to-peer **Key-Value Store** shared by every Freenet node.

The keys in that store are not arbitrary strings — they're derived from small pieces of WebAssembly called **contracts** that define how each value is allowed to change. The next two sections introduce the kinds of components that make up a Freenet app, then explain exactly how contract keys are formed and why that makes the system trustless.

## The Three Kinds of Components in a Freenet App

A Freenet app is built from three *kinds* of components — contracts, delegates, and a UI. Most non-trivial apps have **multiple contracts and multiple delegates**, each handling a different concern.

### 1. Contracts (Network State)

A Freenet app typically has **one or more contracts**, each defining a different kind of shared state. River has a single room contract today, but a more complex app might have several (e.g. rooms, user profiles, invitations, search indexes), and each one is a separate contract crate that compiles to its own WASM.

- **Role:** Closer to a **database table** than a database. The contract WASM defines the *schema* (state shape) and the *rules* for validation and merging. Each instance of the contract — there can be many — behaves like an independent row in that table, so a chat app can have thousands of "room" rows all governed by the same room-contract WASM. (How rows are addressed is covered in *How Contract Keys Work* below.)
- **Location:** Runs on the public network (untrusted peers).
- **Functionality:**
  - Defines what state is valid
  - Defines how state can be modified (validate / update / summarize / delta)
- **State:** Holds the actual application data for that instance (arbitrary bytes).
- **Constraint:** Cannot hold private keys or secrets — all state is public unless encrypted by the client.

### 2. Delegates (Local Trust Zone)

A Freenet app may have **one or more delegates**, each handling a different local responsibility — key management, secret storage, background sync, notifications, and so on. Delegates are the local counterpart to contracts: where contracts hold *shared* state on the network, delegates hold *private* state on the user's device.

- **Role:** Trusted middleware between the user and the network.
- **Location:** Runs locally on the user's device, inside the Freenet kernel.
- **Functionality:**
  - **Trust Zone:** Safely stores secrets, private keys, and user data
  - **Computation:** Performs signing, encryption, and complex logic before publishing to the network
  - **Background Tasks:** Can run continuously to monitor contracts or handle notifications even when the UI is closed

### 3. The User Interface (Frontend)

A single UI typically talks to *all* of an app's contracts and delegates.

- **Role:** Interaction layer for the user
- **Location:** Web Browser (SPA) or native app
- **Functionality:**
  - Connects to the local Freenet Kernel via WebSocket/HTTP
  - Built using standard web frameworks (Dioxus, React, Vue, etc.)
  - Agnostic to underlying P2P network complexity
- **How it is published and addressed:** the UI ships as the *state* of a **web
  container contract** — a generic, pre-built contract whose params are your
  32-byte publisher key. Because neither key input contains your UI, **your
  webapp has one permanent URL and is upgraded in place**: `fdev website update`
  publishes v2 to the same address users bookmarked. Do not design around a
  rotating URL, and do not build a redirect contract to work around one. See
  `references/web-container-contract.md`.

**"Native app" above means desktop.** Freenet does not currently support running a full node on mobile devices. Do not recommend or generate a production mobile wrapper without clearly warning about likely bandwidth, battery, thermal, CPU, and background-execution problems. Treat any such work as experimental, require explicit resource measurements before calling it viable, and do not represent it as an official Freenet client without approval from the Freenet Project.

## How Contract Keys Work (and Why Freenet is Trustless)

Now that contracts have been introduced, here's how they're addressed in the network.

The key for a piece of data is derived from the **cryptographic hash of the contract's WebAssembly (WASM) code**, combined with a set of **contract parameters** that identify a specific instance.

- The WASM hash ties the *identity* of the data to its *logic* — change the code, and the key changes.
- The parameters distinguish independent instances of the same contract code. Tying back to the database-table analogy: the WASM is the table schema, and each parametrized instance is a row with its own key and its own state.
- This is what makes the network "trustless" — you don't have to trust the peer that holds the data, because the data is self-verifying against the contract code referenced in the key.

## Data Synchronization & Consistency

Freenet solves "Eventual Consistency" using a specific mathematical requirement:

**Join-semilattice:** The function that merges updates must be associative, commutative and *idempotent*.
- Order Independent: It shouldn't matter what order updates arrive in
- If Peer A merges Update X then Y, and Peer B merges Update Y then X, they must end up with the same result
- Redelivery-safe: `merge(A, A) == A`. Delivery is at-least-once, so the same update *will* arrive twice — after a retry, a re-subscribe, or anti-entropy. A merge that changes the state on re-application never settles. This is the requirement most often missed; see `references/contract-patterns.md` → "Merge Law Requirements" for why identity is not the same thing, and for the property tests.

**A contract must not read the host clock.** `freenet_stdlib::time::now()` is deprecated for contracts as of freenet-core **v0.2.132**. The merge has to be a function of its inputs — that requirement *is* why replicas converge — so a merge that reads the wall clock isn't merely breaking the laws above; they stop being well-formed statements about it. Two peers eleven minutes apart can produce different states from the same delta and neither is wrong. Today a node logs a warning on loading such a contract and `fdev verify-merge` reports a `host_clock_import` diagnostic; nothing traps *yet*, but the call is staged to **trap** (freenet-core#5465), and when it does the failure is per-call rather than a refusal to load, so no re-key is needed. Carry a client-signed timestamp in state and enforce only monotonicity instead — with clear eyes about what that costs, since a client timestamp is an untrusted hint and can't do anti-grief. **Delegates are unaffected.** See `references/state-authorization-patterns.md` → "Time Handling".

**Check your contract against all of this rather than trusting it:**

```bash
fdev verify-merge --wasm your_contract.wasm --state s1.bin --state s2.bin
```

It exercises the merge laws against a real corpus, and separately reports code diagnostics — `host_clock_import` being the one that exists today. A code diagnostic never fails the command: it describes the code, not a law the contract broke.

**Efficiency:** Peers exchange **Summaries** (compact representations) and **Deltas** (patches/diffs) rather than re-downloading full state.

**Requirement: `get_state_delta` must not ship state to a peer that already has it.** When the requester's summary shows it holds everything you have, the delta carries no information, so it must not contain the state or approach the state's size. It *should* be a literally empty `StateDelta` (`vec![]`), which is the unambiguous "converged" answer and what `freenet-scaffold` produces for you; a few tens of bytes of encoding framing from serializing an all-empty struct is acceptable. What matters is delta size relative to state size: 20 bytes against a 500 KB state is fine, a state-sized delta is a broken delta mechanism that re-ships everything on every reconciliation, forever. Your summary must likewise be far smaller than your state. Core is adding a probe for contracts that get this wrong, and it currently costs the network real bandwidth. Full detail, code shapes, and a test are in `references/contract-patterns.md` → "The Delta to an Up-to-Date Peer".

### State and summaries must serialize canonically

**Use deterministic maps everywhere in state AND summaries: `BTreeMap`/`BTreeSet`, never `HashMap`/`HashSet`.** Peers decide they have converged by comparing state bytes, so two peers holding the same logical state in a different byte order heal forever without ever agreeing. Canonical encoding is a platform requirement (freenet-core #5320), and the merge laws are checked on exact bytes because of it. A `HashMap` serializes in nondeterministic order (ciborium), so two identical states can summarize to different bytes and core's byte-level convergence check misfires — spurious heals, or missed ones. The same caution applies to any map inside whatever `summarize` returns.

Beyond that, make sure your state genuinely converges through `summarize` / `delta` / `apply`, and test that it does, rather than assuming a live broadcast reaches every peer.

> **Previously documented here as a live limitation, now fixed.**
> [freenet/freenet-core#4857](https://github.com/freenet/freenet-core/issues/4857)
> ("State updates permanently lost for rarely-changing fields") is **CLOSED**. A
> `ContractQueueFull` drop was silent, and the sender cached its own summary as
> the receiver's on send-Ok, so it believed the peer was current and never
> re-sent — leaving rarely-changing fields (config, permissions, ban lists)
> diverged until the ~5-minute InterestSync heartbeat happened to correct them.
>
> The shipped fix has the queue-full receiver emit a `ResyncRequest`, which makes
> the sender clear its poisoned summary and re-send full state. It is throttled to
> one per (contract, peer) per 30s, because
> [#4251](https://github.com/freenet/freenet-core/issues/4251) showed that one
> request per dropped delta amplifies into a full-state storm onto the same
> saturated queue; [#4862](https://github.com/freenet/freenet-core/pull/4862)
> hardened it against bridge backpressure. See `RESYNC_REQUEST_MIN_INTERVAL` in
> `crates/core/src/ring/interest.rs`.
>
> Do **not** design around multi-minute staleness on rarely-changing fields, and
> do not treat a ban list or permission field as needing to ride alongside a
> frequently-changing one. The earlier guidance to do so is retired.

### Keep summaries small — it is measured, and it is expensive

Summaries are **~23.7% of all outbound bytes on the Freenet network**, and the fleet-mean summary is **16,675 bytes** against a protocol digest-entry size of 21 bytes (freenet-core#5153). A fat summary is not a local inefficiency: it ships to every interested peer on every ~5-minute anti-entropy heartbeat whether or not anything changed, and it sets the floor for how cheaply a peer can be brought up to date.

Every rule below is checkable in review and grounded in a measured finding from River.

1. **Every summary field must be read by `delta()`.** Grep each field name against the `delta()` bodies. A field nothing reads is dead weight re-sent forever.

2. **A value that is only ever compared for equality must be a fixed-width digest, never the thing it fingerprints.** River carried raw Ed25519 signatures in `member_info` purely to run `>`; replacing them with a 16-byte digest measured **135.27 → 28.01 bytes per entry**. The DM summary still does this for a bare `contains()` at 66 bytes/entry — 19,803 bytes at its cap, larger than the whole rest of the summary (freenet/river#596).

3. **Size a digest by who controls the colliding inputs, not by taste.** If a party can grind *both* sides of the comparison, 64 bits is a ~2^32 birthday search — hours on commodity hardware — so use 128. If the attacker controls only one side, 64 may do. Write the threat model in the doc comment. A collision here is not a crash; it is a record that silently never propagates.

4. **Assert the encoding; never derive it.** The *same* 64 bytes cost **66 CBOR bytes** as a byte string and **119** as a derived tuple — ciborium maps `serialize_tuple` to an array where every byte ≥ 24 costs two. River quoted 66 for a type that actually encoded at 119, and the wrong number survived an issue, a PR body, and a review. Hand-write `Serialize` with `serialize_bytes` for any fixed-size byte array, and pin it with a **golden vector**: one fixed input, one fixed expected digest, one fixed expected byte length. A randomised digest oracle misses byte-order bugs intermittently.

5. **Measure size with realistic key values, not small integers.** A `FastHash(i)` for small `i` encodes in 1-3 CBOR bytes; a real key's encodes in 9. A test built from `0..N` understates the per-entry cost by ~30% and will pass review.

6. **A summary should be O(1) or sub-linear in the collections it describes — or justify the linearity in writing.** A flat enumeration grows without bound as your app succeeds. If you keep it linear, state the element cap that bounds it and check `cap × per-entry` against your budget. River's is fully linear; at 200 members × 1000 messages it measures 16,723 bytes.

7. **A lossy summary is legal when `apply_delta` is idempotent — exploit that.** K fixed buckets each holding an 8-byte digest of that bucket's contents makes the summary constant-size: measured **K=16 → 145 bytes, independent of N**, against 3,894 bytes for the flat form at 139 members. `get_state_delta` may then return a *superset* of the true delta, which is sound only if applying an already-held element is a no-op — verify that first. The trade is real: one changed element resends its whole bucket. It wins because summaries go out on every heartbeat while deltas fire only on change, so **measure your summary-broadcast : state-change ratio before committing.**

8. **A capped or pruning collection needs a retention horizon in the summary.** Without one, `delta()` is a pure set difference: the receiver prunes what it just received, neither summary changes, and the pair re-sends forever. Publish the oldest key *held*, only at capacity, so it strictly increases each exchange and the loop provably terminates.

9. **Nothing in a summary should reveal information the recipient is not entitled to.** A summary goes to more peers, more often, than state does. River's DM summary advertises every DM in the room to every member, participant or not, leaking exact DM volume.

10. **A summary is a wire-format commitment: changing it re-keys the contract and strands every existing copy.** Which hash, how wide, which bytes in which order, and how it serializes are all frozen at publish. Keep a registry of past generations (River keeps `legacy_room_contracts.toml`, 31 entries) and expect every abandoned generation to keep costing anti-entropy bandwidth indefinitely — one stranded River generation is currently doing 3,829 failed summary comparisons against **zero** update events (freenet-core#5158). Batch summary changes rather than shipping them one at a time.

## Advanced Capabilities

- **Subscriptions:** Clients can subscribe to contracts and get notified of changes immediately (real-time apps)
- **Contract Interoperability:** Cross-contract reads are implemented and working.
  `validate_state` can return `ValidateResult::RequestRelated(Vec<ContractInstanceId>)`;
  the host fetches those contracts and re-invokes with `RelatedContracts` populated
  (`fetch_related_for_validation_network` in
  `crates/core/src/contract/executor/runtime/contract_ops.rs`, on both the PUT and
  UPDATE paths). The machinery behind it is real: a related fetch that would block the
  serial contract loop is deferred to an off-loop waiter, bounded by
  `MAX_INFLIGHT_DEFERRALS = 256` with an RAII guard giving exactly-once resume, and an
  over-cap op surfaces `MissingRelated` rather than growing unboundedly
  (freenet-core#4391, `crates/core/src/contract.rs`). freenet-core#2870 ("Complete
  related contract mechanism implementation") is still open but is itself partly stale —
  the UPDATE-path `todo!()` it cites at runtime.rs:946 no longer exists.

**The thing to get right is not whether it works, but what you are allowed to read.**
A contract's verdict must be a function of its inputs, or replicas diverge. Reading
another contract widens the input set to something that changes underneath you:

- Reading an **immutable** fact (a certificate, a signed key) is safe — every peer gets
  the same answer forever.
- Reading a **monotonic** fact in the once-true-always-true direction is safe.
- **Gating validity on mutable or growing state is not.** "Reject if the other party has
  more than N entries" flips from valid to invalid as their state grows, so peers
  validating at different moments disagree and never converge. That class of rule belongs
  in client-side policy, not in `validate_state`.

Practical limits:

- **One round only.** A `RequestRelated` is fetched and retried **exactly once**; a
  second is an error (`contract/executor/runtime/contract_ops.rs:431-432`), capped at
  `MAX_RELATED_CONTRACTS_PER_REQUEST = 10` ids. No chained dependencies.
- On the client-facing UPDATE surface, `UpdateData::RelatedStateAndDelta` is the form
  you send; bare `UpdateData::RelatedState` / `RelatedDelta` are rejected from
  `ContractRequest::Update` and reserved for the runtime's own request-related
  orchestration, which surfaces `RelatedState` to your WASM itself.
- A related fetch that times out can wedge an UPDATE merge (freenet-core#4077, open).
- Related state resolved during *validation* is never captured by the conformance
  system (freenet-core#5376, open), so a contract that depends on that path is
  unjudgeable — and an unjudgeable contract reads exactly like a clean one.
- `freenet-scaffold`'s `#[composable]` has no inter-contract awareness
  (freenet-core#2870), so cross-contract dependencies are hand-rolled.

The mechanism with code, and which of the two paths to request related state
from, is in `references/state-authorization-patterns.md` →
"Related-Contracts Mechanism".

---

## Development Workflow

Follow these phases in order.

> **Building on an app you do NOT own** — reading River rooms, using the
> ghostkeys delegate, indexing another project's contracts? Do not hardcode
> their contract or delegate key. It is `BLAKE3(BLAKE3(wasm) ‖ params)`, so it
> moves on every re-key of theirs, including a bare version bump, and the
> failure is silent: every read comes back looking like "this user has nothing
> stored". Pinning a version of their crate does not help — that pins you to
> their view of the key as of their release, which is the thing that went stale.
> Fetch their key at runtime instead: resolve their author-signed pointer if
> they publish one, and otherwise read it from their webapp bundle, which is
> what ghostkeys does today. Pointer adoption is thin, so expect the fallback to
> be the path for most apps right now. Either beats a compiled-in constant. See
> `references/building-on-other-apps.md`.
>
> **Working on an app that already exists?** Before anything else, check whether
> it hardcodes a *delegate key* belonging to a platform delegate it does not own
> (ghostkeys being the one in use today). That constant goes stale on every
> re-key of that delegate — including a bare version bump — and the failure is
> silent: every request comes back looking like "this user has nothing stored".
> One grep, and the fix is a runtime fetch. See
> `references/delegate-patterns.md` → "Depending on Someone Else's Delegate".
> This broke every ghostkeys integration in August 2026 and was found by a
> confused user rather than by any test.
>
> **Already shipped v1 and here to UPGRADE?** (bump `freenet-stdlib`, ship a new
> contract/delegate version, or fix a bug that re-keys the WASM) — go straight to
> **`references/upgrade-and-migration.md` → "Upgrading a Freenet dApp — the painless
> path"**, the single start-to-finish playbook. A routine WASM/stdlib bump is
> **low-risk and mechanical when you designed for it at v1**, not "recreate
> everything and all invites die" — River's live 0.6→0.8 stdlib re-key (verified
> 2026-07-12) auto-migrated every room on refresh, kept every invite and the
> 78-member Official room intact, and needed no recreation. The phases below build
> a *new* dApp; the playbook ties the upgrade steps together (v1 design
> precondition → reproducible builds → register the outgoing hash → `freenet-migrate`
> → publish → do NOT recreate instances or warn of dead invites).

### Phase 1: Contract Design (Shared State)

Start by listing each *kind* of shared state your app needs — each kind becomes its own contract crate. Then design each one in turn using the questions below.

**Key questions (per contract):**
- What data must all users see consistently for this concern?
- How should conflicts be resolved when two users update simultaneously?
- What cryptographic verification is needed?
- What are the state components and their relationships?
- What parameters distinguish one instance from another (e.g. room owner key, profile owner key)?
- If users reference each other (messaging, contacts, profiles), what is the user-facing identifier? It should be short, self-certifying, and stable across WASM upgrades — derived from a key, never a contract key. See `identity-and-addressing.md`.
- Can strangers write to this contract? If so, what stops one attacker minting ten thousand keys and flooding it? There is no server to host a CAPTCHA, so the mechanisms available are proof-of-work and ghost keys (a blind-signed certificate proving an anonymous donation — a cost the attacker cannot beat with better hardware, and not burned as waste heat). **The recommended shape is both**: proof-of-work as the always-sufficient default, with a ghost key offered as a way to *skip the wait*, surfaced while the grind is running and the user is blocked anyway. That lets you set difficulty by what deters an attacker rather than by what your slowest device tolerates, while never pricing anyone out. See `identity-and-addressing.md` → "Cryptographic CAPTCHA". **Present the choice to the developer rather than picking silently**: ghost keys cost their users money, that money funds Freenet, and the mint is centralized (verification is not). Those are product and architecture decisions, not technical details to settle on the developer's behalf.
- How large can this contract's state realistically grow? **Keep each contract instance's state small — target well under 4 MB, not just under the host's 50 MiB hard cap.** A GET transfers the *entire* state before the UI can render anything, so state size is felt directly as load latency, and `validate_state`/`update_state`/`summarize_state` WASM execution cost scales with it too. If a kind of data can grow without bound (message history, uploaded files, a membership list that only grows), don't let one contract instance absorb all of it — shard by the natural unit of write concurrency instead (one contract per room, per user, per time-window, per shard-key, etc.), so each instance stays small regardless of how large the *dataset* gets in aggregate. See `state-authorization-patterns.md` → "State Size Budget".

**Implementation steps:**
1. Define state structure using `#[composable]` macro from freenet-scaffold
2. Implement `ComposableState` trait for each component
3. Implement `ContractInterface` trait for the contract
4. Ensure all state updates satisfy the merge laws (associative, commutative, idempotent), and that `get_state_delta` returns a negligible delta (ideally zero bytes, never state-sized) when the requester's summary already matches your state (see `contract-patterns.md`)
5. **Every field in state must be covered by a cryptographic signature** -- contracts run on untrusted peers who can modify unsigned fields. Write a test for each signed field verifying that tampering causes verification failure. See contract-patterns.md for versioned signature patterns when adding fields later.
6. **Plan contract upgrade from v1 — it's low-risk and mechanical when you design for it.** A WASM change moves the contract key, but if you anchor your app's durable references on a **stable identity anchor independent of the WASM** — an owner/user key, fixed singleton params, a DID, or an index contract mapping a stable name → current key (options in `upgrade-and-migration.md` step 1) — the upgrade is transparent: the client re-derives the new contract key from the *unchanged* anchor, so invites, share links and membership survive. River's 0.6→0.8 re-key on the live network kept every room and invite; recreation is only for deliberately rotating the anchor itself, never for a routine contract/stdlib bump. State is carried forward by a backward probe from a committed legacy-code-hash registry, packaged by the `freenet-migrate` crate (0.6.0, with `freenet-migrate-build` 0.2.0) — do not hand-roll it. **Read the `freenet-app-migration` skill before writing any of it, if you have it**: it owns the migration doctrine — when to probe, which probe outcomes may seal a completion marker, and the failure modes that lose data with a green build. It ships separately from this plugin, so if it is not installed, `contract-patterns.md` and `upgrade-and-migration.md` carry the same rules and are enough to build against. See `contract-patterns.md` → "Contract WASM Upgrade & State Migration" for the key-derivation mechanism, `upgrade-and-migration.md` for the operational discipline, and the `freenet-migrate-adoption` skill for swapping an existing hand-rolled sweep over to the crate.
7. **Read `state-authorization-patterns.md` before designing the second iteration.** It captures cross-cutting patterns (per-item vs bundled signatures, replay protection via monotonic counter / tombstones / cross-context binding, signed-payload hygiene, why a contract must not read the host clock and what to carry instead, related-contracts limits, wire-format stability) that bite on every contract beyond the trivial.

References:
- `references/contract-patterns.md` — `ContractInterface`, the merge laws, composable state, basic signatures.
- `references/state-authorization-patterns.md` — authentication, replay protection, signed-payload hygiene, time (contracts must not read the host clock), related-contracts, wire-format stability, common pitfalls.
- `references/identity-and-addressing.md` — short self-certifying user-facing addresses, keeping large (post-quantum) keys out of identifiers, identity that survives WASM upgrades, and blocking bots without a server (ghost keys vs proof-of-work).

### Phase 2: Delegate Design (Private State)

Determine what private data each user needs stored locally and split it across delegates by responsibility (e.g. one delegate per trust boundary or per long-running background task). Most apps need at least one delegate; many need several.

> **Know the limits before you lean on a delegate for background work.** A
> delegate runs only when something pokes it: there is no scheduled wakeup
> (freenet-core#3972). Its contract GET reads the local store only, and its
> contract subscribe registers no network demand, so subscribing does not keep a
> contract alive in the network (freenet-core#4669). Both are open with no fix
> merged as of 2026-08-30.
> Test that work against a real node: `freenet local` never runs the loop that
> services a delegate's contract requests, so a delegate's GET, PUT, UPDATE and
> SUBSCRIBE all silently do nothing there (freenet-core#5273).
> `references/delegate-patterns.md` → "Delegate Capabilities" has the verified
> detail and the current state.

**Key questions (per delegate):**
- What user-specific data needs persistence? (keys, preferences, cached data)
- What signing/encryption operations are needed?
- What permissions are needed for sensitive operations?
- Does a **platform delegate** already do this? Delegates are callable across apps, so some responsibilities are worth borrowing rather than building. [ghostkeys](https://github.com/freenet/ghostkeys) is the one that exists today: it holds the user's ghost-key identities and signs on your behalf, and it renders the user's allow/deny prompt itself, so you implement no permission flow. See `identity-and-addressing.md` → "Cryptographic CAPTCHA" for what it is for, how it pairs with proof-of-work as an escape hatch rather than replacing it, and the two caveats worth relaying to the developer: the mint is centralized, and Freenet has a funding interest in you choosing it.

**Implementation steps:**
1. Define request/response message types
2. Implement `DelegateInterface` trait
3. Handle secret storage operations (Store, Get, Delete, List)
4. Implement cryptographic operations (signing, encryption)
5. **Design for secret migration from v1** -- when delegate WASM changes, the delegate key changes and all stored secrets become inaccessible. There is **no `ExportSecrets` request in the stdlib wire protocol** and no node-level copy-forward. The mechanism messages each old delegate key via `DelegateRequest::ApplicationMessages`, re-running the old WASM to read its secrets, and folds the signing keys forward (encryption secrets are re-derived) — so **only a predecessor whose already-deployed WASM answers can be recovered from**, which makes this forward-only. `freenet-migrate` ships that answer as `handle_export_request` (since 0.3.0) for you to call from your delegate; River needs no *special* handler only because its chat delegate already answered a general-purpose `GetRequest`/`ListRequest` over its own secret namespace, which most delegates do not. Every release shipped without an export answer adds one permanently unrecoverable generation — see delegate-patterns.md → "A delegate migration is forward-only". Keep a committed registry of old delegate keys and migrate promptly — the re-run breaks after a stdlib/ABI bump (freenet/river#204). See delegate-patterns.md for the mechanism; `freenet-migrate` codifies the delegate registry and build codegen, but delegate secret carry-forward has no core mechanism and never will — a node-level attempt (`RegisterDelegateWithPredecessors`) was built, shipped, then found forgeable and disabled as a security fix (freenet-core#5199), and after three rejected trust-model designs, app-level migration is settled standing policy, not an interim measure. App-level does not mean bespoke: `freenet-migrate` ships the delegate-side entry points (`migrate_delegate_secrets`, `register_delegate_with_migration`, unchanged since 0.5.0; crates.io is now 0.6.0, whose break is contract-half only), and River, Delta and ghostkeys all drive them on `main` at 0.5.0. Note that River and Delta run the crate's walk *alongside* their existing hand-rolled sweep, which stays authoritative for now; retiring the sweep is a later release, after the walk field-validates. See delegate-patterns.md → "Delegate secret migration: no core mechanism, and why" for the full history, the `freenet-migrate-adoption` skill for the swap procedure, and freenet-core#2776 for live status. See `upgrade-and-migration.md` for the operational discipline (resumable/interrupted-migration recovery, migration telemetry, and the upgrade test harness).

Reference: `references/delegate-patterns.md`

### Phase 3: UI Design

Build the user interface connecting to contracts and delegates. Two approaches:

#### Option A: Dioxus (Rust → WASM)

Best for: teams already in Rust, complex state logic shared with contracts.

**Implementation steps:**
1. Set up Dioxus project with WASM target
2. Implement WebSocket connection to Freenet gateway
3. Create synchronizer for contract state subscriptions
4. Implement delegate communication for private storage
5. Build reactive UI components
6. **Vendor your stylesheets, fonts, and scripts.** The gateway serves every
   webapp under a same-origin CSP — CDN `<link>` / `<script>` tags from
   `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, etc.
   are blocked in production even though they work in `dx serve` /
   `vite dev`. See `references/ui-patterns.md` "Gateway CSP: Vendor Your
   Assets".

#### Option B: TypeScript + Vite

Best for: web developers, faster iteration, familiar tooling (npm, SCSS, etc.).

**Implementation steps:**
1. Set up Vite project with `@freenetorg/freenet-stdlib` (TypeScript package)
2. Use `FreenetWsApi` class for WebSocket connection (handles FlatBuffers serialization)
3. Pass empty string auth token to `FreenetWsApi` constructor (sandbox blocks cookie reading)
4. Use Vite `define` to inject contract hashes and delegate key bytes at build time
5. For delegate communication, dynamically import internal FlatBuffers types (`ClientRequestT`, `ApplicationMessagesT`, etc.)
6. Build reactive UI with vanilla TS, or any framework (React, Vue, Svelte)

#### Validate the UI in a real browser (both options)

A Freenet UI's real render path only runs in a browser. A Dioxus UI ships as a
WASM bundle, so rendering a component tree to a string in a Rust test does not
exercise the compiled bundle, its event handlers, or its asset paths, and both
options reach the node over a WebSocket that unit tests never touch.
**Drive the UI with Playwright (or equivalent browser automation) from
the first screen onward, not only at release time.** Treat "I built the
component" as unfinished until a browser has loaded it and a script has clicked
through it.

1. Serve the UI locally (`dx serve` for Dioxus, `vite dev` for TypeScript) and
   drive it with Playwright against mock or offline data, so render correctness,
   navigation, and form validation gate every PR. This is the `offline` tier in
   `references/production-smoke-testing.md`, which has a starter spec.
2. Assert the browser console is clean in every flow. WASM panics, failed
   requests, and CSP blocks surface only as console or network errors, so a UI
   that looks correct in a screenshot can still be panicking on every
   interaction.
3. Once a local node is running, re-run the same flows against the
   gateway-served webapp (the `iso` tier). Reaching your app there needs
   `frameLocator` and an absolute-URL `goto`, because the gateway wraps every
   webapp in an iframe shell.

For interactive debugging rather than scripted specs, the Playwright MCP browser
tools drive a running `dx serve` or local node directly. See the `local-dev`
skill, "Debugging with Playwright".

References:
- `references/ui-patterns.md` - WebSocket connection models, gateway CSP,
  serving large binary assets from a dedicated contract, framework-specific
  patterns.
- `references/production-smoke-testing.md` - the four test tiers, the
  development-loop browser-validation recipe, and the iframe-shell Playwright
  idioms.

### Phase 4: Build, Test, and Deploy

Set up the build system, CI, and deployment pipeline.

**Implementation steps:**
1. Set up build orchestration — either `Makefile.toml` (cargo-make) or plain `Makefile`
2. Add a preflight task that runs fmt, clippy, tests, and migration checks before publish
3. Add GitHub Actions CI workflow (runs on push and PRs)
4. Back up contract state to the delegate for network resilience
5. **Add a production-liveness smoke test.** A ~50-line Playwright spec
   asserting the gateway-hosted webapp mounts, vendored CSS loaded, and the
   browser console is clean catches CSP blocks, iframe-shell mistakes, and
   broken archives that no unit test reaches. See
   `references/production-smoke-testing.md`.
6. **Check the gateway port and (optionally) tar reproducibility.** The
   gateway runs on `7509` — older docs and scripts still reference `50509`.
   For byte-reproducible webapp archives across build hosts, invoke `tar`
   with the GNU flags listed under "Tooling Preflight" in
   `references/build-system.md`.

7. **Publish the UI as a web container contract — its URL is permanent, and
   you upgrade in place.** Shipping a new release does **not** rotate the
   gateway URL: the UI is the container's *state*, while the contract key is
   `BLAKE3(BLAKE3(container_wasm) || publisher_key)` and neither input contains
   your UI.
   `fdev website init` once (it prints your URL and writes your signing key),
   then `fdev website publish` / `fdev website update` for every release
   thereafter. **Back up the signing key on day one** — lose it and the site is
   frozen at its last version forever, and no redirect can rescue it. Keep
   `fdev`'s built-in versioning unless you have a concrete reason not to: a
   hand-rolled counter seeded *below* the stored version bricks the site
   permanently, so if you must switch, seed strictly above the current
   on-network version. Whether to pin the container WASM with `--contract-wasm`
   is a real trade-off (stable address vs. freezing a third-party contract
   implementation) — read it before deciding. See
   `references/web-container-contract.md`. Do **not** build a redirect/pointer
   contract for stable URLs; you already have one.
8. **Plan contract-WASM stability before the first release.** A
   `cargo update` in the workspace root must not silently rotate
   contract IDs. See `references/build-system.md` →
   "Per-contract lockfile isolation".
9. **Test the upgrade path and make migration resumable.** The dangerous
   inputs are *old-state -> new-code* and *interrupted migration*, neither
   exercised by testing the new version on fresh state. Add an old-format-load
   test and an interrupted-migration-recovery test, and make migration
   idempotent + resumable (in-progress marker cleared only on full success) +
   non-destructive + regression-gated + observable. See
   `references/upgrade-and-migration.md`.

References:
- `references/build-system.md` — build, CI, packaging, tooling
  preflight, per-contract lockfile isolation, contract-ID
  reproducibility caveat, pre-commit hook for stray `.wasm`.
- `references/production-smoke-testing.md` — iframe shell architecture,
  Playwright recipe for post-publish liveness checks.
- `references/web-container-contract.md` — how a webapp is addressed and
  upgraded **in place** at a permanent URL, `fdev website`, version
  monotonicity, key backup, and the size budget.
- `references/facade-pattern.md` — indirection for the rare case where you
  must move an audience to a *different* contract (container-WASM migration
  or publisher-key rotation). Not needed for ordinary releases.
- `references/upgrade-and-migration.md` — operational discipline for safe
  contract/delegate upgrades: the five migration properties (idempotent,
  resumable, non-destructive, regression-gated, observable), enumerating
  dynamic key families, the upgrade test harness, and staged reversible rollout.
- `references/building-on-other-apps.md` — the *consumer* side: integrating with
  a contract or delegate you do not own, resolving the author's pointer instead
  of pinning a key, the seven outcome arms, and what a pointer does not tell you.

## Project Structure Templates

### Dioxus (Rust) UI

```
my-dapp/
├── common/                    # Shared types between contract/delegate/UI
│   └── src/
│       ├── lib.rs
│       └── state/            # State definitions
├── contracts/                 # one subdirectory per contract crate
│   ├── room-contract/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs        # ContractInterface implementation
│   └── profile-contract/      # add more as the app grows
│       └── ...
├── delegates/                 # one subdirectory per delegate crate
│   ├── chat-delegate/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs        # DelegateInterface implementation
│   └── identity-delegate/     # add more as the app grows
│       └── ...
├── ui/
│   ├── Cargo.toml
│   ├── Dioxus.toml
│   └── src/
│       ├── main.rs
│       └── components/
├── Cargo.toml                # Workspace root
└── Makefile.toml             # cargo-make build tasks
```

### TypeScript + Vite UI

```
my-dapp/
├── contracts/
│   └── my-contract/
│       ├── Cargo.toml
│       └── src/lib.rs        # ContractInterface implementation
├── delegates/
│   └── my-delegate/
│       ├── Cargo.toml
│       └── src/lib.rs        # DelegateInterface implementation
├── web/
│   ├── package.json
│   ├── vite.config.ts         # Injects contract/delegate keys at build time
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── index.ts           # Entry point, connection flow
│       ├── freenet-api.ts     # FreenetWsApi wrapper
│       ├── delegate-api.ts    # Delegate FlatBuffers message building
│       ├── identity.ts        # Identity management (delegate + fallback)
│       ├── types.ts           # Shared TypeScript types
│       └── components/        # UI components
├── Cargo.toml                 # Workspace root (contracts + delegates)
└── Makefile                   # Build orchestration
```

## Reference Project

[River](https://github.com/freenet/river) demonstrates all patterns:
- Contracts: `contracts/room-contract/`
- Delegates: `delegates/chat-delegate/`
- UI: `ui/`
- Common types: `common/`

## Key Dependencies

Track the versions River (the reference dApp) uses. Mismatched versions cause
deserialization failures, missing features, and "variant index out of range"
errors. Check [River's workspace Cargo.toml](https://github.com/freenet/river/blob/main/Cargo.toml)
before pinning.

As of August 2026 — River pins `freenet-stdlib = "0.8.5"`, which is the
current crates.io release, so River and upstream no longer diverge. If you
are moving code off an older pin, the step is 0.6 → 0.8 (no 0.7 was ever
published to crates.io): it added Base58-stringified `contract_states` keys
in `NodeDiagnosticsResponse`, hardened wire-boundary enums with
`#[non_exhaustive]`, and removed the world-known `DEFAULT_CIPHER` /
`DEFAULT_NONCE` constants, so you need the wildcard match arms / random
cipher generation documented in `references/delegate-patterns.md`.

`DEFAULT_CIPHER`/`DEFAULT_NONCE` is the break that gets quoted, but it is
**not the only one**. `ContractInstanceId::from_bytes` is deprecated as of
**0.8.5** in favour of `from_base58` — it is a delegating alias, so it still
compiles, but a crate built with `-D warnings` (most CI) fails on it. Check
the version before acting on this: `from_base58` does not exist in 0.8.2,
0.8.3 or 0.8.4, so a port that stops short of 0.8.5 sees no warning and has
nothing to change. Note
what the rename is telling you: it parses base58 **text**, not raw bytes.
If you were passing it a raw 32-byte id it was already wrong; the
replacement there is `ContractInstanceId::new([u8; 32])`, not
`from_base58`. Budget a compile-and-read pass over the deprecation
warnings rather than assuming a single documented break is the whole
list.

```toml
# Workspace-wide (Cargo.toml) — matches River pin.
freenet-stdlib = { version = "0.8.5", features = ["contract"] }
freenet-scaffold = "0.2.2"
freenet-scaffold-macro = "0.2.2"

# UI crate (ui/Cargo.toml): enables WebApi/WebSocket helpers
freenet-stdlib = { workspace = true, features = ["net"] }

# UI framework
dioxus = { version = "0.7.9", features = ["web"] }
```

The `contract` feature is required for contract crates targeting
`wasm32-unknown-unknown`; use the `delegate` feature for delegate crates.
The `net` feature pulls in `WebApi` for the UI.

### TypeScript UI

For UIs built with TypeScript + Vite (Option B in Phase 3), depend on the
matching `@freenetorg/freenet-stdlib` release:

```json
{
  "dependencies": {
    "@freenetorg/freenet-stdlib": "^0.2.0"
  },
  "devDependencies": {
    "vite": "^6.0",
    "typescript": "^5.0",
    "sass": "^1.0"
  }
}
```

The TS package v0.2.0 brought the API to parity with the Rust client:
`FreenetWsApi` with **promise-based** `get`/`put`/`update`
(`await api.X(...)`, resolves/rejects on the matching response), full
`ResponseHandler` including `onContractNotFound`/`onSubscribeResponse`/
`onClose`, inbound `ReassemblyBuffer`, and transparent outbound chunking
for payloads >512 KB. Callbacks still fire alongside the promise-based
calls for backward compatibility; the default request timeout is 30 s.
`subscribe` is also promise-based **from TS package 0.4.0** (resolves/
rejects on the matching `SubscribeResponse`); on the npm-published 0.3.0
and earlier it resolves as soon as the request is sent, never on the
host's response — use the `ResponseHandler` callbacks to detect a refused
subscribe on those versions. `disconnect` resolves on send in every
version. See `references/ui-patterns.md` for the full pattern (including
which stdlib version you need for which behavior) and a warning about the
private `sendRequest` cast used for delegate messages until a public
builder lands.

### Security: removed encryption defaults

stdlib v0.8.0 (PR #75) **removed** the public constants `DEFAULT_CIPHER`
and `DEFAULT_NONCE` to close a CVE-class issue (world-known keys leaked
into any binary that imported them). They are still present in 0.6.0 and
0.6.1. Delegates that previously used these
must now generate random values per session — e.g.
`let key: [u8; 32] = rand::random(); let nonce: [u8; 24] = rand::random();`.
Code still referencing the old constants will fail to compile against
stdlib 0.8 or newer.

It is not the only break on the way to current stdlib, and treating it as the
whole list is how a `-D warnings` build fails after the port looks finished —
see "Key Dependencies" above for `ContractInstanceId::from_bytes` →
`from_base58` (0.8.5).

---

## Improving This Skill

This skill is designed to be self-improving. When encountering issues while using this skill, agents should file GitHub issues or submit PRs to improve it.

### When to File an Issue

File an issue at `freenet/freenet-agent-skills` when:
- Instructions are unclear or ambiguous
- Information is missing for a common use case
- Code examples don't compile or are outdated
- Patterns don't match current River implementation
- A referenced API has changed

### How to File an Issue

```bash
gh issue create --repo freenet/freenet-agent-skills \
  --title "dapp-builder: <brief description>" \
  --body "## Problem
<describe what was unclear or incorrect>

## Context
<what were you trying to accomplish>

## Suggested Improvement
<optional: how the skill could be improved>"
```

### Submitting a PR

For concrete improvements:

```bash
# Clone and create branch
gh repo clone freenet/freenet-agent-skills
cd freenet-agent-skills
git checkout -b improve-<topic>

# Make changes to dapp-builder/SKILL.md or references/*.md
# ... edit files ...

# Submit PR
git add -A && git commit -m "dapp-builder: <description>"
gh pr create --title "dapp-builder: <description>" \
  --body "## Changes
<describe improvements>

## Reason
<why this helps>"
```

### What Makes a Good Improvement

- Fixes factual errors or outdated information
- Adds missing patterns discovered while building a dApp
- Clarifies confusing instructions based on real usage
- Adds test examples that would have helped
- Updates code to match current Freenet/River APIs
