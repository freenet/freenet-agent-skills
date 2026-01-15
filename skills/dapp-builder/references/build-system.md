# Build System

Freenet dApps use `cargo-make` for orchestrating builds across contracts, delegates, and UI.

## Prerequisites

```bash
# Install cargo-make
cargo install cargo-make

# Install WASM target
rustup target add wasm32-unknown-unknown

# Install Dioxus CLI
cargo install dioxus-cli

# Install Freenet tools (from freenet-core repo)
cargo install --path crates/core   # freenet binary
cargo install --path crates/fdev   # fdev development tool

# For UI styling (optional)
npm install  # in ui/ directory
```

## Project Cargo.toml (Workspace Root)

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
freenet-stdlib = "0.1"
freenet-scaffold = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## Makefile.toml

```toml
[config]
default_to_workspace = false

# ============================================
# CONTRACT BUILD
# ============================================

[tasks.build-contract]
description = "Build the contract to WASM"
command = "cargo"
args = [
    "build",
    "--release",
    "--target", "wasm32-unknown-unknown",
    "-p", "my-contract",
]

[tasks.copy-contract]
description = "Copy contract WASM to UI public folder"
dependencies = ["build-contract"]
script = '''
mkdir -p ui/public/contracts
cp target/wasm32-unknown-unknown/release/my_contract.wasm ui/public/contracts/
'''

# ============================================
# DELEGATE BUILD
# ============================================

[tasks.build-delegate]
description = "Build the delegate to WASM"
command = "cargo"
args = [
    "build",
    "--release",
    "--target", "wasm32-unknown-unknown",
    "-p", "my-delegate",
]

[tasks.copy-delegate]
description = "Copy delegate WASM to UI public folder"
dependencies = ["build-delegate"]
script = '''
mkdir -p ui/public/contracts
cp target/wasm32-unknown-unknown/release/my_delegate.wasm ui/public/contracts/
'''

# ============================================
# UI BUILD
# ============================================

[tasks.build-css]
description = "Build Tailwind CSS"
cwd = "./ui"
command = "npm"
args = ["run", "build:css"]

[tasks.build-ui]
description = "Build UI with Dioxus"
dependencies = ["build-css", "copy-contract", "copy-delegate"]
cwd = "./ui"
command = "dx"
args = ["build", "--release"]

# ============================================
# DEVELOPMENT
# ============================================

[tasks.dev]
description = "Run development server"
dependencies = ["copy-contract", "copy-delegate"]
cwd = "./ui"
command = "dx"
args = ["serve"]

[tasks.dev-example]
description = "Run with example data"
dependencies = ["copy-contract", "copy-delegate"]
cwd = "./ui"
command = "dx"
args = ["serve", "--features", "example-data"]

[tasks.dev-no-sync]
description = "Run without Freenet sync"
dependencies = ["copy-contract", "copy-delegate"]
cwd = "./ui"
command = "dx"
args = ["serve", "--features", "no-sync"]

[tasks.dev-example-no-sync]
description = "Run with example data and no sync"
dependencies = ["copy-contract", "copy-delegate"]
cwd = "./ui"
command = "dx"
args = ["serve", "--features", "example-data,no-sync"]

# ============================================
# FULL BUILD
# ============================================

[tasks.build]
description = "Full release build"
dependencies = [
    "build-contract",
    "build-delegate",
    "build-ui",
]

# ============================================
# PACKAGING & DEPLOYMENT
# ============================================

[tasks.package-webapp]
description = "Create webapp archive"
dependencies = ["build"]
script = '''
mkdir -p target/webapp
cd target/dx/my-dapp-ui/release/web/public
tar -cJf ../../../../../webapp/webapp.tar.xz .
'''

[tasks.sign-webapp]
description = "Sign webapp for deployment"
dependencies = ["package-webapp"]
script = '''
# Requires web-container-tool from freenet-core
web-container-tool sign \
    --webapp target/webapp/webapp.tar.xz \
    --metadata target/webapp/webapp.metadata \
    --output target/webapp/webapp.parameters \
    --key signing-key.pem
'''

[tasks.publish]
description = "Publish to local Freenet node"
dependencies = ["sign-webapp"]
script = '''
# Requires fdev from freenet-core
fdev publish \
    --code contracts/web-container-contract/target/wasm32-unknown-unknown/release/web_container_contract.wasm \
    --state target/webapp/webapp.tar.xz \
    --parameters target/webapp/webapp.parameters
'''

# ============================================
# TESTING
# ============================================

[tasks.test]
description = "Run all tests"
command = "cargo"
args = ["test", "--workspace"]

[tasks.test-contract]
description = "Run contract tests"
command = "cargo"
args = ["test", "-p", "my-contract"]

[tasks.clippy]
description = "Run clippy"
command = "cargo"
args = ["clippy", "--workspace", "--all-targets"]

# ============================================
# LOCAL MODE TESTING
# ============================================

[tasks.local-node]
description = "Start Freenet in local mode for testing"
command = "freenet"
args = ["local"]
# Runs on 127.0.0.1:7509 by default

[tasks.publish-local]
description = "Publish contract to local node"
dependencies = ["build-contract"]
script = '''
fdev publish \
    --code target/wasm32-unknown-unknown/release/my_contract.wasm \
    --parameters parameters.bin \
    contract \
    --state initial_state.bin
'''
# fdev defaults to local mode (127.0.0.1:7509)

[tasks.update-local]
description = "Send update to local contract"
script = '''
fdev execute update ${CONTRACT_KEY} \
    --delta delta.bin \
    --address 127.0.0.1 \
    --port 7509
'''
```

## UI package.json (for Tailwind)

```json
{
  "scripts": {
    "build:css": "npx tailwindcss -i ./src/input.css -o ./public/tailwind.css --minify",
    "watch:css": "npx tailwindcss -i ./src/input.css -o ./public/tailwind.css --watch"
  },
  "devDependencies": {
    "tailwindcss": "^3.4"
  }
}
```

## Common Commands

```bash
# Development
cargo make dev                    # Start dev server
cargo make dev-example            # With example data
cargo make dev-no-sync            # Without Freenet connection
cargo make dev-example-no-sync    # Both features

# Building
cargo make build                  # Full release build
cargo make build-contract         # Just the contract
cargo make build-delegate         # Just the delegate
cargo make build-ui               # Just the UI

# Unit testing
cargo make test                   # All tests
cargo make clippy                 # Linting

# Integration testing with local mode
cargo make local-node             # Start local Freenet node
cargo make publish-local          # Publish contract to local node

# Deployment
cargo make package-webapp         # Create archive
cargo make sign-webapp            # Sign for deployment
cargo make publish                # Publish to Freenet
```

## Contract WASM Optimization

For smaller WASM files, add to contract's Cargo.toml:

```toml
[profile.release]
opt-level = "z"      # Optimize for size
lto = true           # Link-time optimization
codegen-units = 1    # Better optimization
panic = "abort"      # Smaller binary

[profile.release.package.my-contract]
opt-level = "z"
```

## Build Verification

River's CLI includes build verification to prevent deploying stale contracts:

```rust
// cli/build.rs
fn main() {
    // Embed contract WASM into CLI binary
    println!("cargo:rerun-if-changed=../contracts/my-contract/src/lib.rs");

    let wasm = std::fs::read("../target/wasm32-unknown-unknown/release/my_contract.wasm")
        .expect("Contract WASM not found - run `cargo make build-contract` first");

    // Verify it matches the freshly built version
    let fresh_hash = sha256(&wasm);
    // ... verification logic
}
```

## Testing with Local Mode

Freenet's **local mode** runs a standalone executor without network connectivity. Use this for testing contract and delegate logic during development.

### What Local Mode Does

- Runs contracts/delegates locally without P2P networking
- WebSocket API available at `127.0.0.1:7509`
- Operations complete immediately (no network round-trips)
- Subscribe operations are no-ops (no remote peers)
- All state stored and retrieved locally

### Development Workflow

**Terminal 1: Start Local Node**
```bash
# With debug logging
RUST_BACKTRACE=1 RUST_LOG=freenet=debug freenet local

# Or via cargo-make
cargo make local-node
```

**Terminal 2: Publish and Test**
```bash
# Build contract
cargo make build-contract

# Publish to local node (fdev defaults to local mode)
fdev publish \
    --code target/wasm32-unknown-unknown/release/my_contract.wasm \
    --parameters params.bin \
    contract \
    --state initial_state.bin

# Returns contract key, e.g.: HjT8Kf2...

# Send an update
fdev execute update HjT8Kf2... \
    --delta update.bin

# Get current state
fdev execute get HjT8Kf2...
```

**Terminal 3: Run UI**
```bash
# UI connects to local node at ws://127.0.0.1:7509
cargo make dev
```

### Testing Levels

1. **Unit Tests** - Test state logic without Freenet
   - Commutativity tests (see contract-patterns.md)
   - Serialization round-trips
   - Validation logic
   ```bash
   cargo test -p my-contract
   ```

2. **Local Mode** - Test with real Freenet executor
   - Contract deployment and state management
   - Delegate secret storage
   - UI integration via WebSocket
   ```bash
   freenet local  # Terminal 1
   cargo make dev # Terminal 2
   ```

3. **Network Simulation** - Test P2P behavior (advanced)
   ```bash
   fdev test single-process --nodes 5
   ```
   Runs multiple simulated nodes in-memory for network behavior testing.

### Environment Variables

```bash
# Enable debug logging
RUST_LOG=freenet=debug

# Show backtraces on panic
RUST_BACKTRACE=1

# fdev mode (default is already "local")
MODE=local
```

## River Build Reference

See [River's Makefile.toml](https://github.com/freenet/river/blob/main/Makefile.toml) for a complete build configuration.
