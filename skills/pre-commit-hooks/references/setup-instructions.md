# Freenet Core Pre-Commit Hooks - Quick Setup Guide

This guide provides multiple approaches to set up pre-commit hooks that run `cargo fmt` and `cargo clippy` before commits.

---

## Choose Your Approach

### Option 1: Simple Bash Script (Recommended for Quick Start)

**Best for:** No dependencies, works anywhere, simple setup

#### Installation

```bash
# Navigate to your freenet-core repository
cd /path/to/freenet-core

# Download the hook script
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/skills/pre-commit-hooks/references/pre-commit-hook.sh > .git/hooks/pre-commit

# Make it executable
chmod +x .git/hooks/pre-commit

# Test it
git commit --allow-empty -m "test: hook installation"
```

**Or copy from local skills repository:**
```bash
cp /path/to/freenet-agent-skills/skills/pre-commit-hooks/references/pre-commit-hook.sh /path/to/freenet-core/.git/hooks/pre-commit
chmod +x /path/to/freenet-core/.git/hooks/pre-commit
```

#### What It Does

- Runs `cargo fmt --check` on commit
- Runs `cargo clippy --all-targets --all-features -- -D warnings` on commit
- Blocks commit if either check fails
- Simple, no external dependencies

---

### Option 2: Pre-Commit Framework (Official freenet-core Approach)

**Best for:** Working in freenet-core, team consistency, advanced features

The freenet-core repository has `.pre-commit-config.yaml` pre-configured with multiple checks.

#### Installation

```bash
# 1. Install the pre-commit framework
pip install pre-commit
# OR: brew install pre-commit
# OR: conda install -c conda-forge pre-commit

# 2. Navigate to freenet-core repository
cd /path/to/freenet-core

# 3. Install the hooks
pre-commit install

# 4. (Optional) Enable commit message validation
git config core.hooksPath .githooks

# 5. Test it
pre-commit run --all-files
```

#### What It Does

- **cargo fmt** - Code formatting check
- **Smart Clippy** - Only lints modified packages (performance optimized)
- **YAML validation** - Validates YAML syntax
- **Merge conflict detection** - Catches conflict markers
- **TODO-MUST-FIX blocker** - Prevents commits with TODO-MUST-FIX
- **Conventional Commits** - Validates commit message format

#### Additional Commands

```bash
# Run hooks manually
pre-commit run              # On staged files
pre-commit run --all-files  # On entire codebase

# Skip specific hook for one commit
SKIP=cargo-clippy git commit -m "message"

# Update hook versions
pre-commit autoupdate

# Uninstall hooks
pre-commit uninstall
```

---

### Option 3: Claude Code Native Hooks (Real-Time Feedback)

**Best for:** AI-assisted development, catching issues during coding

Claude Code can run checks automatically when files are edited during AI sessions.

#### Installation

Create `.claude/settings.json` in your project root:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'file=\"$(echo \"$STDIN\" | jq -r .tool_input.file_path)\"; if [[ $file == *.rs ]]; then cargo fmt && cargo clippy --all-targets -- -D warnings; fi'"
          }
        ]
      }
    ]
  }
}
```

#### What It Does

- Runs after Claude edits/writes `.rs` files
- Provides immediate feedback during development
- Catches issues before you even commit

#### Other Hook Events

You can also use:
- `PreToolUse` - Before tool execution (can block)
- `UserPromptSubmit` - When you submit a prompt
- `Stop` - When Claude finishes responding

See: https://code.claude.com/docs/en/hooks-guide.md

---

## Comparison Table

| Feature | Bash Script | Pre-Commit Framework | Claude Code Hooks |
|---------|-------------|---------------------|-------------------|
| **Dependencies** | None | Requires `pre-commit` | Built-in |
| **Setup time** | 30 seconds | 2 minutes | 1 minute |
| **When runs** | On git commit | On git commit | During Claude work |
| **Checks** | fmt + clippy | fmt + clippy + 5 more | Customizable |
| **Performance** | Checks all | Smart per-package | Checks changed |
| **Updates** | Manual | `pre-commit autoupdate` | Edit settings |
| **Team sharing** | Copy script | Framework config | Per-developer |

---

## Usage Examples

### Normal Workflow (All Approaches)

```bash
# 1. Make changes
vim src/node.rs

# 2. Stage changes
git add src/node.rs

# 3. Commit (hooks run automatically)
git commit -m "fix: resolve connection timeout"
```

### When Formatting Check Fails

```
$ git commit -m "fix: something"
Running pre-commit checks...
Checking code formatting...
Diff in src/node.rs at line 42:
❌ Code formatting check failed!
Run 'cargo fmt' to fix formatting issues.
```

**Fix it:**
```bash
cargo fmt
git add -u
git commit -m "fix: something"
```

### When Clippy Check Fails

```
$ git commit -m "feat: new feature"
Running clippy on all targets...
warning: unused variable: `count`
  --> src/node.rs:42:9
   |
42 |     let count = peers.len();
   |         ^^^^^ help: prefix with underscore: `_count`
❌ Clippy check failed!
```

**Fix it:**
```bash
# Fix the warning in your editor
vim src/node.rs

# Commit again
git add src/node.rs
git commit -m "feat: new feature"
```

### Bypassing Hooks (Emergency Only)

```bash
git commit --no-verify -m "emergency fix"
```

**Warning:** Use sparingly! Hooks prevent CI failures.

---

## Worktree Setup

Each git worktree has its own `.git/hooks/` directory.

### Bash Script (Install in Each Worktree)

```bash
# Main worktree
cd ~/code/freenet/freenet-core/main
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Feature branch worktree
cd ~/code/freenet/freenet-core/fix-123
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

**Helper script:**
```bash
#!/bin/bash
# Save as ~/bin/install-freenet-hooks.sh
WORKTREE=$1
cp ~/path/to/pre-commit-hook.sh "$WORKTREE/.git/hooks/pre-commit"
chmod +x "$WORKTREE/.git/hooks/pre-commit"
echo "✅ Hooks installed in $WORKTREE"
```

Usage: `install-freenet-hooks.sh ~/code/freenet/freenet-core/fix-456`

### Pre-Commit Framework (Install in Each Worktree)

```bash
cd ~/code/freenet/freenet-core/main
pre-commit install

cd ~/code/freenet/freenet-core/fix-123
pre-commit install
```

### Claude Code Hooks (Install Once)

Configure in `.claude/settings.json` at project root - works for all worktrees.

---

## Troubleshooting

### Problem: Hook doesn't run

**Bash Script:**
```bash
ls -l .git/hooks/pre-commit  # Check exists and executable
cat .git/hooks/pre-commit    # Verify content
chmod +x .git/hooks/pre-commit
```

**Pre-Commit Framework:**
```bash
pre-commit install  # Reinstall
ls -l .git/hooks/pre-commit  # Should reference pre-commit
```

### Problem: Cargo commands fail

**Check you're in the right directory:**
```bash
pwd           # Should be repository root
ls Cargo.toml # Should exist
```

**Check cargo is installed:**
```bash
cargo --version
rustup --version
```

### Problem: `pre-commit: command not found`

**Install the framework:**
```bash
pip install pre-commit
# OR
brew install pre-commit
```

### Problem: Pre-commit is very slow

**First run is slow (downloads environments):**
- This is normal
- Subsequent runs are fast (cached)

**To speed up:**
```bash
# Commit smaller changesets
git add specific/files
git commit -m "message"
```

### Problem: Claude Code hook not working

**Check JSON syntax:**
```bash
cat .claude/settings.json | jq .
```

**Check hook is configured correctly:**
```bash
cat .claude/settings.json | jq '.hooks.PostToolUse'
```

**Test command manually:**
```bash
file="src/test.rs"
if [[ $file == *.rs ]]; then
  cargo fmt
  cargo clippy --all-targets -- -D warnings
fi
```

---

## Best Practices

### Recommended Combinations

**For freenet-core contributors:**
- ✅ Option 2 (pre-commit framework) - official approach
- ✅ Option 3 (Claude Code hooks) - real-time feedback
- ⚠️  Option 1 as emergency fallback if pre-commit breaks

**For casual Rust projects:**
- ✅ Option 1 (bash script) - simple and effective
- ⏭️  Upgrade to Option 2 as project matures

**For AI-assisted development:**
- ✅ Option 3 (Claude Code hooks) - catches issues immediately
- ✅ Option 1 or 2 - safety net before commits

### Hook Hygiene

1. **Don't bypass hooks routinely** - Fix issues instead
2. **Keep hooks fast** - Slow hooks disrupt workflow
3. **Update regularly** - `pre-commit autoupdate` monthly
4. **Test hooks** - Run manually before relying on them
5. **Document custom hooks** - Help future developers

---

## CI Alignment

All approaches run the same checks as CI:

**Pre-commit checks:**
- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`

**CI checks (`.github/workflows/ci.yml`):**
- `cargo fmt --check`
- `cargo clippy --locked -- -D warnings`
- `cargo test --workspace` (not in hooks - too slow)

Hooks catch **fast quality checks** locally. CI runs **complete validation** including tests.

---

## Additional Resources

### Official Documentation

- **Freenet-core hook guide:** `docs/PRE_COMMIT_HOOK_GUIDE.md`
- **Pre-commit framework:** https://pre-commit.com
- **Claude Code hooks:** https://code.claude.com/docs/en/hooks-guide.md
- **Conventional Commits:** https://www.conventionalcommits.org

### In This Repository

- **Bash script:** `skills/pre-commit-hooks/references/pre-commit-hook.sh`
- **Main documentation:** `skills/pre-commit-hooks/SKILL.md`

### Freenet-Core Configuration Files

- **Pre-commit config:** `.pre-commit-config.yaml`
- **Smart clippy script:** `scripts/pre-commit-clippy.sh`
- **Commit message hook:** `.githooks/commit-msg`
- **CI workflow:** `.github/workflows/ci.yml`

---

## Quick Decision Guide

**"I want the simplest setup possible"**
→ Use **Option 1** (bash script)

**"I'm contributing to freenet-core"**
→ Use **Option 2** (pre-commit framework) - it's the official way

**"I want real-time feedback during AI coding"**
→ Use **Option 3** (Claude Code hooks)

**"I want maximum protection"**
→ Use **all three** (Claude Code → git commit → CI)

**"Pre-commit framework isn't installed and I can't install it"**
→ Use **Option 1** (bash script) - no dependencies needed
