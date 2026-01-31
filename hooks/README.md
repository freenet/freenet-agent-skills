# Hooks for Freenet Development

This directory contains two types of hooks for Freenet development:

## 1. Claude Code Hooks (Included with Plugin)

**File**: `hooks.json`

These hooks run automatically during Claude Code sessions when the `freenet` plugin is installed.

### What it does

Runs `cargo fmt` and `cargo clippy` automatically **before** Claude runs git commit commands.

- **Event**: `PreToolUse` (before Bash tool execution)
- **Trigger**: Detects `git commit` commands
- **Scope**: Only in Cargo projects (checks for `Cargo.toml`)
- **Action**: Blocks commit if formatting or linting fails

### Installation

Automatically activated when you install the plugin:

```bash
/plugin install freenet
```

### How it works

When Claude attempts to run `git commit`:
1. Hook intercepts the command before it executes
2. Checks if already running (via `FREENET_HOOK_RUNNING` env var) to prevent recursion
3. Runs `cargo fmt --check` to verify formatting
4. Runs `cargo clippy --all-targets --all-features -- -D warnings`
5. If checks pass → commit proceeds
6. If checks fail → commit is blocked with error message

### Recursion Protection

The hook uses the `FREENET_HOOK_RUNNING` environment variable to prevent infinite recursion:

- When the hook runs `cargo fmt` and `cargo clippy`, those are also Bash commands
- Without protection, the hook would intercept its own subcommands
- The `FREENET_HOOK_RUNNING=1` guard ensures the hook only runs once per commit attempt
- Any Bash commands executed while the hook is running will see this variable and immediately exit

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
| **When runs** | Before Claude's `git commit` | On `git commit` (native git) |
| **Installation** | Automatic with plugin | Manual copy |
| **Scope** | All staged files | All staged files |
| **Action** | Block commit if issues | Block commit if issues |
| **Checks** | cargo fmt + clippy | cargo fmt + clippy |
| **Best for** | AI-assisted commits | All commits |

## Recommended Setup

**Use the Claude Code hook** (automatic with plugin) for AI-assisted development. It catches issues before Claude commits.

**Optionally add the git hook** for:
- Commits made outside Claude Code sessions
- Team members not using the plugin
- Extra safety net

Both hooks run the same checks (cargo fmt + clippy), so the git hook mainly serves as a fallback for non-Claude commits.

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
