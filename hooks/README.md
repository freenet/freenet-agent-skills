# Hooks for Freenet Development

This directory contains two types of hooks for Freenet development:

## 1. Claude Code Hooks (Included with Plugin)

**File**: `hooks.json`

These hooks run automatically during Claude Code sessions when the `freenet` plugin is installed.

### What it does

Runs `cargo fmt` automatically after Claude edits or writes Rust files.

- **Event**: `PostToolUse` (after Edit or Write tools)
- **Scope**: Only on `.rs` files in Cargo projects
- **Action**: Checks formatting, auto-formats if needed

### Installation

Automatically activated when you install the plugin:

```bash
/plugin install freenet
```

### How it works

When Claude edits a Rust file:
1. Hook checks if file ends with `.rs` and `Cargo.toml` exists
2. Runs `cargo fmt --check` on the file
3. If check fails, runs `cargo fmt` to auto-format
4. Shows success message

---

## 2. Git Pre-Commit Hook (Manual Installation)

**File**: `pre-commit` (bash script)

A git hook that runs before commits to catch formatting and lint issues.

### What it does

Blocks commits if code doesn't pass:
- `cargo fmt --check` - Code formatting
- `cargo clippy --all-targets --all-features -- -D warnings` - Lints

### Installation

Copy to your freenet-core repository:

```bash
# From freenet-core repository root
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/hooks/pre-commit > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or copy locally:

```bash
cp /path/to/freenet-agent-skills/hooks/pre-commit /path/to/freenet-core/.git/hooks/pre-commit
chmod +x /path/to/freenet-core/.git/hooks/pre-commit
```

### Worktree setup

Each git worktree needs the hook installed separately:

```bash
cd ~/code/freenet/freenet-core/fix-123
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/hooks/pre-commit > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

### Bypass (emergency only)

```bash
git commit --no-verify -m "message"
```

---

## Comparison

| Feature | Claude Code Hook | Git Pre-Commit Hook |
|---------|------------------|---------------------|
| **When runs** | During Claude editing | On `git commit` |
| **Installation** | Automatic with plugin | Manual copy |
| **Scope** | Single file edited | All staged files |
| **Action** | Auto-format on save | Block commit if issues |
| **Checks** | cargo fmt only | cargo fmt + clippy |
| **Best for** | Real-time feedback | Final validation |

## Recommended Setup

Use **both** for maximum protection:

1. **Claude Code hook** catches issues during AI-assisted development
2. **Git hook** ensures nothing slips through before commits

Together they provide layered quality checks at different stages of development.

## Note About freenet-core's Pre-Commit Framework

The freenet-core repository officially uses the [pre-commit framework](https://pre-commit.com) with `.pre-commit-config.yaml`. This bash script hook is provided as a lightweight alternative for:

- Environments where pre-commit framework isn't available
- Quick setup without dependencies
- Personal preference for simple bash scripts

To use freenet-core's official setup instead:

```bash
pip install pre-commit
cd /path/to/freenet-core
pre-commit install
```
