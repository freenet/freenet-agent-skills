# Build System

A Freenet dApp build orchestrates contracts, delegates and a UI. Use whatever task runner you like: River and freenet/raven both use cargo-make (`Makefile.toml`), but a plain Makefile or shell scripts work the same. What matters is the checklist below, and above all that the contract and delegate WASM come out byte-identical every time.

## Build pipeline checklist

A dApp build has to:

1. Build contract and delegate WASM through **one canonical script** (`scripts/build-contracts.sh`; see "Byte-reproducibility"). Never build a to-be-published contract any other way.
2. Build the UI after the WASM exists, because the UI embeds the delegate's code hash and key.
3. Package and publish the UI with `fdev website` (see `web-container-contract.md`). The hand-rolled alternative is River's `web-container-tool sign`, which needs a committed counter file for the version (see "Contract ID reproducibility caveat").
4. Run the pre-publish gate (see "Pre-Publish Checks") before every publish.

Reference projects: [River's Makefile.toml](https://github.com/freenet/river/blob/main/Makefile.toml) (cargo-make, Dioxus UI) and [freenet/raven's Makefile.toml](https://github.com/freenet/raven/blob/main/Makefile.toml) (formerly freenet-microblogging; cargo-make, TypeScript/Vite UI).

## Prerequisites

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-make   # if you use cargo-make
# Dioxus UI: dx must equal the dioxus version in Cargo.lock. A mismatched dx prints
# "incompatible" and still builds, so a bad build can be published.
cargo binstall -y dioxus-cli@<dioxus version in Cargo.lock>
```

### Installing `fdev` / `freenet`

Install them from the freenet-core release that matches the gateway you publish to. Download `fdev-<triple>.tar.gz` and `freenet-<triple>.tar.gz` from the GitHub release (Linux triples end `-unknown-linux-musl`; macOS `aarch64-apple-darwin` or `x86_64-apple-darwin`), extract them and put them on `PATH`. It takes seconds, and it pins you to a known fdev flag surface: an old fdev lacks flags such as `execute update --as-state`, which the facade pointer flip needs.

`cargo install --path crates/fdev` (or `crates/core` for `freenet`) builds whatever is on the checked-out branch, which may not match the gateway. **Version drift between your CLI and the gateway breaks publishes silently**, because wire formats change across stdlib minor releases. Rebuild every consumer (CLI, webapp, test tools) against the same stdlib version as the gateway you publish to, and run the smoke test (`production-smoke-testing.md`) before shipping.

## Per-contract lockfile isolation

**The problem.** A Freenet contract ID is `hash(wasm, parameters)`. The WASM bytes depend on every transitive dependency. If your contract shares the workspace `Cargo.lock` with the UI crate, a routine bump to `dioxus`, `chrono`, `serde`, etc. resolves a different patch version deep in the contract's dependency tree, the WASM bytes shift, the contract ID rotates, and every user's stored state under the old ID is orphaned.

This happens silently. There is no warning. The first sign is users saying "my inbox is empty after the update."

**The fix.** Exclude every committable-state contract and delegate from the workspace and give it its own committed `Cargo.lock`.

```toml
# Cargo.toml (workspace root)
[workspace]
members = ["common", "ui", "tools/*"]
exclude = [
    "contracts/inbox",
    "contracts/facade",
    "contracts/facade-types",      # shared types used by facade contract
    "delegates/token-record",
]
```

```toml
# contracts/inbox/Cargo.toml: NOT a workspace member
[package]
name        = "my-inbox-contract"
version     = "0.1.0"
edition     = "2021"
publish     = false

# Makes this crate its own workspace root, so fdev puts its output in this
# crate's own target/ and not the UI workspace's.
[workspace]

[lib]
crate-type = ["cdylib", "rlib"]

[features]
default = ["freenet-main-contract"]
freenet-main-contract = []

[dependencies]
freenet-stdlib = { version = "=<ver>", features = ["contract"] }
serde          = { version = "=<ver>", features = ["derive"] }
```

Commit `contracts/inbox/Cargo.lock` and build `--locked`. `cargo update` at the workspace root cannot touch it. Pin direct dependencies with `=x.y.z` if you want a manifest edit to be the only way a direct version moves; the lockfile is what fixes the transitive ones.

**`CARGO_TARGET_DIR` per crate.** `fdev build` puts output in the `target/` of the workspace it finds, or the crate's own `target/`. Set `CARGO_TARGET_DIR` to the crate's own directory in each build task so an isolated contract never shares a `target/` with the UI, whose dependency tree differs:

```toml
[tasks.build-inbox-contract]
description = "Build the inbox contract WASM (lockfile-isolated)"
script = '''
CRATE_DIR="${CARGO_MAKE_WORKING_DIRECTORY}/contracts/inbox"
cd "$CRATE_DIR"
CARGO_TARGET_DIR="$CRATE_DIR/target" fdev build
'''
```

**Deliberate rotation.** When you do want to rotate the contract ID (a contract upgrade), it is a small diff: change the dependency, rebuild, and pair the change with the migration in `upgrade-and-migration.md` → "Contract mechanics" (register the outgoing code hash in your legacy registry first). The rotation is then explicit, reviewable and recoverable.

## Contract ID reproducibility caveat

Contract IDs are **not reproducible from unpinned source on an arbitrary host**: toolchain version, `wasm-opt`, and dependency drift all move the WASM bytes, and the ID moves with them (see the next section). With the pins in place they are reproducible, which is why the byte-equality CI gate below can be green and is worth enforcing. They are unconditionally reproducible from the committed **artifacts**: the ID is `BLAKE3(BLAKE3(wasm) || params)` and nothing else.

A signing timestamp does not move the contract ID. The webapp's `version` and signature live in its metadata, which is part of the contract's state; the ID depends only on the container WASM and the `parameters` file (32 bytes of Ed25519 verifying key). Different signing times change the state at the same ID, which is the in-place upgrade described in `web-container-contract.md`.

The `version` field still matters for a different failure. The container's `update_state` requires it to be **strictly** greater than the stored version, so a bad version scheme breaks your ability to publish an update while leaving the ID alone. A commit-hash scheme is not monotonic and broke the v0.1.1 release of freenet/mail for exactly this reason. Wall-clock seconds fail the same way when two publishes tie or a clock runs ahead. Use a committed monotonic counter file (River keeps `published-contract/contract-version.txt`).

**Practical consequences.**

- Commit `published-contract/<contract>.wasm` and `published-contract/*.parameters`. Those two files *are* your address; `contract-id.txt` is a convenience copy derived from them, worth committing so a mistake is visible in review.
- CI should enforce byte-equality on the committed **WASM**, which is the check that actually catches an unintended re-key. Recomputing the ID from the committed WASM + parameters is a valid second check.
- A second developer can redo a publish from a clean checkout and reach the same ID, provided they use the committed WASM and parameters rather than rebuilding the contract.
- A pinned-vector test that passes in a tree with a cached `target/` is weaker evidence than it looks, since the cache can supply the bytes the test expects. Run it from a fresh build (see "Byte-reproducibility").
- `rust-toolchain.toml` must be committed and mirrored in any CI workflow that rebuilds the contract. Rustc is not the only cause of a mismatch, though; see "Byte-reproducibility" before concluding it is the compiler.

## Byte-reproducibility: the lockfile is necessary but NOT sufficient

A contract's key is `BLAKE3(BLAKE3(wasm) || params)`, so a rebuild that changes the WASM bytes re-keys the contract and orphans every user's stored state, and the bytes change from more than source edits. This is the single biggest source of silent data loss; treat reproducibility as a first-class requirement.

**The minimum bar (do all three):**

1. **Commit a `Cargo.lock`** (workspace root, or per contract per "Per-contract lockfile isolation"; the latter is more robust because a UI-only `cargo update` then cannot touch the contract). River's `Cargo.lock` was gitignored until freenet/river#393, so every build re-resolved the dependency graph and a transitive drift silently changed the WASM and the contract/delegate keys with **no code change at all**.
2. **Pin the toolchain** with a committed `rust-toolchain.toml` (rustc version changes the bytes).
3. **Build `--locked`.** A `--locked` build fails loudly on a stale lock instead of silently re-resolving and re-keying.

**Why that is still not enough.** These also change the bytes, and none is covered by the lockfile:

- **`wasm-opt` / binaryen version.** If your build runs `wasm-opt` (directly or via `dx`), its version changes the output. Pin it (or build in a pinned container).
- **The UI toolchain (`dx`) version.** For a UI compiled to WASM, the Dioxus CLI version affects the bytes just like rustc does. Pin it.
- **`cargo fmt`.** Panic locations embed `file:line`, so reformatting a contract crate moves the panic metadata and therefore the WASM bytes and the contract address, with no semantic change and nothing in the diff that looks like a re-key. Either treat a contract crate's formatting as frozen between deliberate re-keys, or run `cargo fmt` and re-key on purpose, registering the outgoing hash first.
- **Absolute build-path embedding, and remapping your own source path is not enough.** Release binaries embed panic locations as `file:line`, and for dependencies cargo passes **absolute** paths, so the registry root lands in the bytes. A dependency's source path inside the cargo registry, such as `<cargo home>/registry/src/.../blake3-<version>/`, appears in the bytes. Because the address is `BLAKE3(BLAKE3(wasm) ‖ params)`, **a contract built this way is bound to the machine that built it**: a CI runner and a dev box produce different contracts from one commit, so nobody can reproduce what was deployed. A developer who remaps only the repo root will still ship a machine-specific contract and see nothing wrong.

  Remap all three varying roots (`CARGO_HOME`, `RUSTUP_HOME`, and the repo) or build in a pinned container. **`--remap-path-prefix` is the option that works.** Cargo's `trim-paths = "all"` profile setting is still unstable on stable Cargo, and there is no `-Ctrim-paths` codegen flag, so check stabilization again before reaching for it. The working example is `freenet-bitcoin/scripts/build-contracts.sh`:

  ```bash
  CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
  RUSTUP_DIR="${RUSTUP_HOME:-$HOME/.rustup}"

  export CARGO_BUILD_RUSTFLAGS="\
  --remap-path-prefix=$CARGO_DIR=/cargo \
  --remap-path-prefix=$RUSTUP_DIR=/rustup \
  --remap-path-prefix=$REPO=/build"
  ```

  **The replacement names are part of the contract's identity.** They are arbitrary, but changing one re-keys every contract, so pick them once and treat them as frozen. This is also why the flags belong in one canonical script and nowhere else: a second invocation that sets them differently, or not at all, produces a different contract while looking like the same command.

- **A stale `target/` silently changes contract identity.** `cargo clean -p` on the workspace crates is **not** sufficient: dependency artifacts are reused, and under fat LTO they yield a different module and therefore a different contract. Measured: two fresh clones at different paths agreed with each other, and a long-lived working tree agreed with neither. Anything whose hash you intend to record or pin must be built into a throwaway target dir:

  ```bash
  D=$(mktemp -d); ./scripts/build-contracts.sh "$D"; rm -rf "$D"
  ```

  The nasty case is not a build that fails; it is a bundle built against a stale `target/` that derives perfectly self-consistent addresses for a contract nobody publishes to any more. That has happened. Cross-check the embedded bytes against the migration registry, not only against themselves.

**Build-command footgun: always use the canonical build script.** Building a contract crate **alone** (`cargo build -p my-contract`) can produce *different* bytes than building it **co-built** with sibling crates, because cargo unifies feature flags across the crates in one invocation. River's `-p room-contract` alone and `-p room-contract -p chat-delegate` together yield different `room_contract.wasm` bytes for exactly this reason (a sibling enables an extra feature on a shared crate). Never rebuild a to-be-published contract with an ad-hoc `cargo build -p`; go through the project's canonical build script so the feature unification, and therefore the key, is stable.

## Keep committed WASM and its identity together

Whatever directories hold committed `.wasm` files, a change to one must travel in the same commit as the contract-id file and, for a contract or delegate that already has users, the registry entry for the outgoing hash (see `upgrade-and-migration.md`). A stray `.wasm` added elsewhere is either a forgotten build artifact or snapshot drift the author did not notice, and both cost users access to old state. Enforce this in the publish task and in CI (see "Pre-Publish Checks"); a local git hook is optional.

## Project layout

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

## Project Cargo.toml (workspace root)

```toml
[workspace]
members = [
    "common",
    "contracts/*",
    "delegates/*",
    "ui",
]
resolver = "2"

[workspace.dependencies]
# Versions: see "Dependencies" below.
freenet-stdlib = { version = "<ver>", features = ["contract"] }
freenet-scaffold = "<ver>"
freenet-scaffold-macro = "<ver>"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## Dependencies

Put every crate in an app on one stdlib line. A WASM cannot link two stdlibs
(`__frnt_set_id` is an unconditional export), and `freenet-migrate` fixes the line:

| `freenet-migrate` | `freenet-stdlib` |
|---|---|
| 0.8.x | 0.12.x |
| 0.7.x and older | 0.8.x |

A new app starts on the newest of both; check crates.io. On a live app a stdlib bump is
a re-key, so follow `upgrade-and-migration.md`. River is on stdlib 0.8.5, which is the path for an app not yet ready to re-key.

Below stdlib 0.11.0 a delegate crate exposes `DelegateCtx` write and subscribe methods
no node implements: calling one compiles, publishes, and fails at module instantiation.
Manifest lifecycle events need 0.12.0 and `wakeups` need 0.12.1.

**Crate features.** Contract and delegate crates both use stdlib's `contract` feature;
there is no `delegate` feature. The UI adds `net`, which pulls in `WebApi`. The
`#[contract]` and `#[delegate]` macros gate their WASM exports on a feature of your own
crate, `freenet-main-contract` or `freenet-main-delegate`. Declare it and enable it by
default: a plain `cargo build` without it succeeds and the WASM exports none of the contract functions (three runtime symbols remain), and
`fdev build` passes the feature, which cargo refuses if the crate does not declare it.

```toml
[lib]
crate-type = ["cdylib", "rlib"]

[features]
default = ["freenet-main-contract"]   # "freenet-main-delegate" in a delegate crate
freenet-main-contract = []
```

**No `rand` or `getrandom` in a contract or delegate crate.** They leave imports the
node cannot resolve at instantiation (freenet/river#241). A UI crate is different: it
needs `getrandom`'s `js` feature (`ui-patterns.md`).

**TypeScript UI.** Depend on `"@freenetorg/freenet-stdlib": "^0.4.0"` or newer. A caret
on a 0.x version pins the minor, so an older range never reaches the 0.4.0 behaviour
`ui-patterns.md` relies on.

**Moving up from an older stdlib.** Read the compiler's deprecation warnings, because a
`-D warnings` build fails on them.

- 0.8.0 removed `DEFAULT_CIPHER` and `DEFAULT_NONCE`, so code naming them no longer
  compiles. The `cipher` and `nonce` fields of `DelegateRequest::RegisterDelegate`
  remain only for wire compatibility. The node discards them, so any fixed-size bytes
  work, zeros included.
- 0.6 to 0.8 (no 0.7 was published) added `#[non_exhaustive]` to wire enums, so matches
  need wildcard arms.
- 0.8.5 deprecated `ContractInstanceId::from_bytes` for `from_base58`, which parses
  base58 text. For raw 32 bytes use `ContractInstanceId::new([u8; 32])`.

## `fdev publish`: contracts vs delegates

| | Contracts | Delegates |
|---|---|---|
| `--code` input | **Raw WASM** from `target/wasm32-unknown-unknown/release/` | **Packaged file** from `build/freenet/` (created by `fdev build --package-type delegate`) |
| Subcommand | `contract` | `delegate` |
| State | `--state initial_state.json` | None |

`--code` and `--parameters` go before the `contract`/`delegate` subcommand; contract flags such as `--state` and `--webapp-archive` go after it.

To get a contract key without publishing, use `fdev get-contract-id --code ... --parameters ...`; `fdev inspect <packaged file> key` prints `code key: <key>` for empty parameters. Derive a delegate's key and `code_hash` offline from the built WASM (a delegate key is `BLAKE3(code_hash || parameters)`, the same rule as a contract key) rather than scraping `fdev publish` output; see freenet/raven's `Makefile.toml` (`build-identity`).

## Contract WASM optimization

Size-optimize contracts with the usual release profile (`opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`). Changing a profile changes the contract's WASM, and therefore its key.

### Signature-heavy contracts: build the crypto crates for speed

`opt-level = "z"` makes signature verification about 1.4x slower than `opt-level = 3`. For a contract whose `validate_state` or `update_state` checks many signatures, that is often the difference between fitting the node's per-call time limit and not. Build only the signature and hash crates for speed and leave everything else at `"z"`:

```toml
[profile.release.package.curve25519-dalek]
opt-level = 3
[profile.release.package.ed25519-dalek]
opt-level = 3
[profile.release.package.sha2]
opt-level = 3
[profile.release.package.blake3]
opt-level = 3
```

Measured 2026-10-26 (ed25519-dalek `verify_strict` in a wasmtime host configured like the node's): about 327 us per signature with the crates at `"z"`, 227 us at `3`, 741 us with a forced 64-bit curve backend, 42-46 us native. The WASM file grows (River's room contract went from 799 KB to 811 KB). Do not force the 64-bit curve backend on `wasm32`: WASM has no 64x64-to-128-bit multiply, so the emulated multiplies make it about 2x slower than the default 32-bit backend.

**Apply this to a new contract, or as part of a planned re-key with migration (`references/upgrade-and-migration.md`), never as a quiet rebuild of a deployed contract.**

**Budget the time per call, measured in WASM.** The node limits each contract call to 5 s. One incoming full-state update runs `validate_state` on the incoming state, `update_state`, then `validate_state` on the result, each a separate call, so the largest valid state AND the merge of two such states must each finish well under that limit. Native `cargo test` timings say nothing about this: in WASM a signature check costs about 5-8x native. Build the largest state your caps allow, time `validate_state` and `update_state` on the release WASM in a wasmtime host, and set the caps from that measurement. If the caps you need still do not fit, the limit is signature cost inside WASM; native-speed verification for contracts is tracked in [freenet-core#6000](https://github.com/freenet/freenet-core/issues/6000).

## Build verification

River's `cli/build.rs` is the reference for a crate that embeds committed WASM and checks it against the built artifact.

### Reproduce build-caching bugs in a real clone, not a worktree

In a worktree `.git` is a *file*, so `println!("cargo:rerun-if-changed=../.git/HEAD")` names a path that cannot resolve, and cargo treats an unresolvable `rerun-if-changed` as always-dirty. The build script then re-runs on every build and never caches, which is exactly the condition under which a stale-artifact bug cannot appear. Resolve git metadata paths with `git rev-parse --git-path <spec>` instead of hardcoding `../.git/...`.

`cargo:` directives are read from stdout only. `eprintln!("cargo:warning=...")` renders nothing, and even on stdout a `cargo:warning` is not a gate because nothing fails on it. When a build script finds a condition that must stop the build, `panic!`.

### Verify no build-machine path survived, and fail closed

A hash-equality check cannot catch a machine-specific path, because the committed artifact it compares against was produced on the same machine. It needs its own check, and that check must **refuse the build** rather than warn. From `freenet-bitcoin/scripts/build-contracts.sh`:

```bash
for f in "$OUT"/my_contract.wasm; do
  for probe in "$CARGO_DIR" "$RUSTUP_DIR" "$REPO" "${HOME:-/nonexistent}"; do
    if grep -qaF -- "$probe" "$f"; then
      echo "REFUSING: $(basename "$f") contains the build-machine path '$probe'." >&2
      exit 1
    fi
  done
  # A path belonging to some other user means a root nobody remapped.
  if grep -qaE -- '/(home|Users)/[A-Za-z0-9._-]+/' "$f"; then
    echo "REFUSING: $(basename "$f") contains a home-directory path." >&2
    grep -aoE -- '/(home|Users)/[A-Za-z0-9._/-]{0,60}' "$f" | sort -u | head >&2
    exit 1
  fi
done
```

Two things make this work. It is a **deny-list of roots known to vary**, not an allow-list of acceptable path shapes (an allow-list would have to enumerate every shape a path can take). And the generic `/home|/Users` probe catches a root nobody thought to remap: a vendored artifact, a build script writing its own path, a dependency baking one in. A varying root that is not on the list is the next instance of this bug.

Put the check in the canonical build script, so it runs on the path `publish` actually takes and not only in CI (see "Pre-Publish Checks").

## Testing with local mode

1. **Unit tests** for state logic: no node. Merge-law tests (`merge-law-compliance.md` → "Testing"), serialization round-trips, validation.
2. **`freenet local`** for contract state logic and UI wiring: a standalone executor, WebSocket API at `127.0.0.1:7509`, operations complete immediately, subscribe is a no-op. **Do not use it to test a delegate's contract access.** A delegate's contract GET/PUT/UPDATE/SUBSCRIBE, notifications and wake-ups silently do nothing there; that needs `freenet network` (see the `local-dev` skill and `delegate-patterns.md`, "`freenet local` Does Not Run the Delegate Contract Loop").
3. **`fdev test --nodes N single-process`** for network behavior: simulated nodes in one process. Flags go before `single-process`.

```bash
freenet local                       # terminal 1
fdev -p 7509 publish --code target/wasm32-unknown-unknown/release/my_contract.wasm \
    --parameters params.bin contract --state initial_state.bin   # prints the contract key
fdev execute update <key> update.bin
fdev execute get <key> --output state.bin
fdev execute subscribe <key>        # streams until Ctrl+C
```

To start from a clean state, stop the test node and delete its own `--data-dir` and `--config-dir` (see the `local-dev` skill). Never delete the default data directory: it is your real node's contracts, delegates and secrets.

## Pre-Publish Checks

Add a preflight task that runs before every publish: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and a `check-migration` step. The `check-migration` step verifies that committed WASM files match what is built from source, and that delegate migration entries exist when the WASM has changed. See Delta's `scripts/check-migration.sh` for a full implementation. Make `publish` depend on `preflight`.

**Wire the gate into the task your publish actually depends on, not only into CI.** A check that runs in CI but not on the path `publish` takes does not gate the moment the mistake becomes permanent, and the two drift apart quietly because nothing fails when they do. Let CI be the second copy.

## GitHub Actions CI

Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` and a `wasm32-unknown-unknown` build in CI as for any Rust project. The job specific to Freenet is the WASM staleness check:

```yaml
  wasm-staleness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - run: cargo install b3sum
      - name: Verify committed WASMs match source
        run: |
          # Go through the canonical script, never a bare `cargo build`: it sets
          # the --remap-path-prefix flags and runs the fail-closed path check.
          # A bare build here embeds the runner's paths and this job fails on a
          # difference that is about the runner, not about the source.
          D=$(mktemp -d)
          ./scripts/build-contracts.sh "$D"
          COMMITTED=$(b3sum ui/public/contracts/my_delegate.wasm | cut -d' ' -f1)
          BUILT=$(b3sum "$D/wasm32-unknown-unknown/release/my_delegate.wasm" | cut -d' ' -f1)
          [ "$COMMITTED" = "$BUILT" ] || { echo "::error::WASM stale"; exit 1; }
```

This job deliberately does **not** restore a `target` cache. It builds into a fresh `mktemp -d`, because a hash recorded from a reused `target/` is not trustworthy (see "Byte-reproducibility"). Caching the registry is fine; caching `target` for a job whose entire output is a hash is not.
