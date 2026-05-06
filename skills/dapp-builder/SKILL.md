---
name: dapp-builder
description: Build decentralized applications on Freenet using river as a template. Guides through designing contracts (shared state), delegates (private state), and UI. Use when user wants to create a new Freenet dApp, design contract state, implement delegates, or build a Freenet-connected UI.
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

## How Contract Keys Work (and Why Freenet is Trustless)

Now that contracts have been introduced, here's how they're addressed in the network.

The key for a piece of data is derived from the **cryptographic hash of the contract's WebAssembly (WASM) code**, combined with a set of **contract parameters** that identify a specific instance.

- The WASM hash ties the *identity* of the data to its *logic* — change the code, and the key changes.
- The parameters distinguish independent instances of the same contract code. Tying back to the database-table analogy: the WASM is the table schema, and each parametrized instance is a row with its own key and its own state.
- This is what makes the network "trustless" — you don't have to trust the peer that holds the data, because the data is self-verifying against the contract code referenced in the key.

## Data Synchronization & Consistency

Freenet solves "Eventual Consistency" using a specific mathematical requirement:

**Commutative Monoid:** The function that merges updates must be a *commutative monoid*.
- Order Independent: It shouldn't matter what order updates arrive in
- If Peer A merges Update X then Y, and Peer B merges Update Y then X, they must end up with the same result

**Efficiency:** Peers exchange **Summaries** (compact representations) and **Deltas** (patches/diffs) rather than re-downloading full state.

## Advanced Capabilities

- **Subscriptions:** Clients can subscribe to contracts and get notified of changes immediately (real-time apps)
- **Contract Interoperability:** Contracts reading other contracts' state is planned but not yet implemented

---

## Development Workflow

Follow these phases in order:

### Phase 1: Contract Design (Shared State)

Start by listing each *kind* of shared state your app needs — each kind becomes its own contract crate. Then design each one in turn using the questions below.

**Key questions (per contract):**
- What data must all users see consistently for this concern?
- How should conflicts be resolved when two users update simultaneously?
- What cryptographic verification is needed?
- What are the state components and their relationships?
- What parameters distinguish one instance from another (e.g. room owner key, profile owner key)?

**Implementation steps:**
1. Define state structure using `#[composable]` macro from freenet-scaffold
2. Implement `ComposableState` trait for each component
3. Implement `ContractInterface` trait for the contract
4. Ensure all state updates satisfy the commutative monoid requirement
5. **Every field in state must be covered by a cryptographic signature** -- contracts run on untrusted peers who can modify unsigned fields. Write a test for each signed field verifying that tampering causes verification failure. See contract-patterns.md for versioned signature patterns when adding fields later.
6. **Plan contract upgrade from v1.** Contract keys change with every WASM hash change, so include an `OptionalUpgrade` pointer in state, keep serialization backwards-compatible, and maintain a `legacy_contracts.toml` migration registry. See contract-patterns.md "Contract WASM Upgrade & State Migration".
7. **Read `state-authorization-patterns.md` before designing the second iteration.** It captures cross-cutting patterns (per-item vs bundled signatures, replay protection via monotonic counter / tombstones / cross-context binding, signed-payload hygiene, `time::now()` gotchas, related-contracts limits, wire-format stability) that bite on every contract beyond the trivial.

References:
- `references/contract-patterns.md` — `ContractInterface`, commutative monoid, composable state, basic signatures.
- `references/state-authorization-patterns.md` — authentication, replay protection, signed-payload hygiene, time, related-contracts, wire-format stability, common pitfalls.

### Phase 2: Delegate Design (Private State)

Determine what private data each user needs stored locally and split it across delegates by responsibility (e.g. one delegate per trust boundary or per long-running background task). Most apps need at least one delegate; many need several.

**Key questions (per delegate):**
- What user-specific data needs persistence? (keys, preferences, cached data)
- What signing/encryption operations are needed?
- What permissions are needed for sensitive operations?

**Implementation steps:**
1. Define request/response message types
2. Implement `DelegateInterface` trait
3. Handle secret storage operations (Store, Get, Delete, List)
4. Implement cryptographic operations (signing, encryption)
5. **Include an `ExportSecrets` handler from v1** -- when delegate WASM changes, the delegate key changes and all stored secrets become inaccessible. The old delegate must be able to hand over its secrets to the new version. See delegate-patterns.md for the authorized migration pattern.

Reference: `references/delegate-patterns.md`

### Phase 3: UI Design

Build the user interface connecting to contracts and delegates.

**Key questions:**
- What components/views does the app need?
- How should state synchronization work?
- What's the user flow for key operations?

**Implementation steps:**
1. Set up Dioxus project with WASM target
2. Implement WebSocket connection to Freenet gateway
3. Create synchronizer for contract state subscriptions
4. Implement delegate communication for private storage
5. Build reactive UI components

Reference: `references/ui-patterns.md`

### Phase 4: Build, Test, and Deploy

Set up the build system, CI, and deployment pipeline.

**Implementation steps:**
1. Set up `Makefile.toml` with build tasks for contract, delegate, and UI
2. Add a `preflight` task that runs fmt, clippy, tests, and migration checks before publish
3. Add GitHub Actions CI workflow (runs on push and PRs)
4. Back up contract state to the delegate for network resilience

Reference: `references/build-system.md`

## Project Structure Template

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

As of April 2026 (River `main`):

```toml
# Workspace-wide (Cargo.toml)
freenet-stdlib = { version = "0.6.0", features = ["contract"] }
freenet-scaffold = "0.2.2"
freenet-scaffold-macro = "0.2.2"

# UI crate (ui/Cargo.toml): enables WebApi/WebSocket helpers
freenet-stdlib = { workspace = true, features = ["net"] }

# UI framework
dioxus = { version = "0.7.3", features = ["web"] }
```

The `contract` feature is required for contract and delegate crates targeting
`wasm32-unknown-unknown`. The `net` feature pulls in `WebApi` for the UI.

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
