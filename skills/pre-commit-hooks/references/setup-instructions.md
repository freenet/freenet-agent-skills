# Freenet Core Pre-Commit Hooks Setup Guide

## Official Documentation

This is a quick reference guide. For complete documentation, see:
- **`docs/PRE_COMMIT_HOOK_GUIDE.md`** in the freenet-core repository
- **Pre-commit framework**: https://pre-commit.com

## Quick Setup

### 1. Install pre-commit Framework

Choose your preferred method:

**Using pip:**
```bash
pip install pre-commit
```

**Using Homebrew (macOS):**
```bash
brew install pre-commit
```

**Using conda:**
```bash
conda install -c conda-forge pre-commit
```

**Using asdf:**
```bash
asdf plugin add pre-commit
asdf install pre-commit latest
asdf global pre-commit latest
```

### 2. Navigate to freenet-core Repository

```bash
cd /path/to/freenet-core
```

### 3. Install the Hooks

```bash
pre-commit install
```

This reads `.pre-commit-config.yaml` and sets up `.git/hooks/pre-commit`.

### 4. (Optional) Enable Commit Message Validation

```bash
git config core.hooksPath .githooks
```

This enables the Conventional Commits format checker for commit messages.

### 5. Verify Installation

```bash
# Run hooks on currently staged files
pre-commit run

# Or test on all files
pre-commit run --all-files
```

## What Gets Checked

The `.pre-commit-config.yaml` configures these checks:

### Rust Quality Checks
- **cargo fmt** - Code formatting (`--check` mode)
- **cargo clippy** - Linting with smart per-package optimization
  - Only checks packages with modified files
  - Treats warnings as errors (`-D warnings`)
  - Special handling for "freenet" package with `--features bench`

### Standard File Checks
- **check-merge-conflict** - Detects merge conflict markers
- **check-yaml** - Validates YAML syntax
- **end-of-file-fixer** - Ensures files end with newline
- **trailing-whitespace** - Removes trailing whitespace

### Custom Checks
- **TODO-MUST-FIX blocker** - Prevents commits with TODO-MUST-FIX markers

### Commit Message Format (via .githooks)
- **Conventional Commits** validation
- Format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`

## Usage Examples

### Normal Development Workflow

```bash
# 1. Make changes
vim src/core/mod.rs

# 2. Stage changes
git add src/core/mod.rs

# 3. Commit (hooks run automatically)
git commit -m "fix: resolve connection timeout issue"
```

### When Formatting Check Fails

```
$ git commit -m "fix: something"
cargo fmt...................................................................Failed
- hook id: cargo-fmt
- exit code: 1
```

Fix it:
```bash
cargo fmt
git add -u
git commit -m "fix: something"
```

### When Clippy Fails

```
$ git commit -m "feat: new feature"
cargo clippy.............................................................Failed
- hook id: cargo-clippy
- exit code: 101

warning: unused variable: `count`
  --> crates/core/src/node.rs:42:9
   |
42 |     let count = peers.len();
   |         ^^^^^ help: if this is intentional, prefix it with an underscore: `_count`
```

Fix the issue:
```bash
# Fix the warning in your editor
vim crates/core/src/node.rs

# Stage and commit
git add crates/core/src/node.rs
git commit -m "feat: new feature"
```

### When TODO-MUST-FIX is Detected

```
$ git commit -m "wip: testing"
Detect TODO-MUST-FIX in staged files..................................Failed
- hook id: detect-todo-must-fix
- exit code: 1

Error: Found TODO-MUST-FIX in staged files. Please address before committing.
src/lib.rs:123: // TODO-MUST-FIX: Handle edge case
```

Either fix the issue or change the marker:
```bash
# Option 1: Fix the issue
vim src/lib.rs  # Implement the fix

# Option 2: Convert to regular TODO if not critical
# Change "TODO-MUST-FIX" to "TODO"
```

### Bypassing Hooks (Emergency Only)

```bash
git commit --no-verify -m "emergency fix"
```

**Warning:** Use sparingly. Hooks exist to prevent CI failures.

### Manual Hook Execution

```bash
# Run all hooks on staged files
pre-commit run

# Run all hooks on entire codebase
pre-commit run --all-files

# Run specific hook only
pre-commit run cargo-fmt
pre-commit run cargo-clippy
pre-commit run check-yaml

# Skip specific hooks for one commit
SKIP=cargo-clippy git commit -m "message"
```

## Worktree Setup

Git worktrees have separate `.git/hooks` directories. Install in each:

```bash
# Main worktree
cd ~/code/freenet/freenet-core/main
pre-commit install

# Feature branch worktree
cd ~/code/freenet/freenet-core/fix-123
pre-commit install

# Another worktree
cd ~/code/freenet/freenet-core/feature-456
pre-commit install
```

**Quick setup script for new worktrees:**
```bash
#!/bin/bash
# save as ~/bin/setup-freenet-worktree.sh

WORKTREE_PATH=$1
cd "$WORKTREE_PATH" || exit 1
pre-commit install
git config core.hooksPath .githooks
echo "✅ Pre-commit hooks installed in $WORKTREE_PATH"
```

Usage:
```bash
setup-freenet-worktree.sh ~/code/freenet/freenet-core/fix-789
```

## Maintenance

### Update Hook Repositories

```bash
pre-commit autoupdate
```

This updates hook versions in `.pre-commit-config.yaml`.

### Clean and Reinstall Hook Environments

```bash
pre-commit clean
pre-commit install-hooks
```

Useful if hooks behave unexpectedly or after framework updates.

### Uninstall Hooks

```bash
pre-commit uninstall
```

## Troubleshooting

### Problem: Hooks don't run on commit

**Solution:**
```bash
# Check if installed
ls -l .git/hooks/pre-commit

# Should see a file managed by pre-commit
cat .git/hooks/pre-commit | head -5

# Reinstall if needed
pre-commit install
```

### Problem: `pre-commit: command not found`

**Solution:** Install the pre-commit framework (see step 1 above)

### Problem: First run is very slow

**Expected behavior:** First run downloads and caches hook environments.
Subsequent runs are much faster.

### Problem: Clippy takes too long

**By design:** The smart clippy script only checks packages with changes.
If you modified a core package, it may check many files.

**Speed it up:**
```bash
# Commit smaller changesets
git add specific/files
git commit -m "message"
```

### Problem: Want to skip a flaky hook temporarily

```bash
SKIP=problematic-hook-id git commit -m "message"
```

Find hook IDs in `.pre-commit-config.yaml` under `id:` fields.

### Problem: Hook environments are stale

```bash
pre-commit clean
pre-commit install-hooks
```

## CI Alignment

Pre-commit hooks align with GitHub Actions CI (`.github/workflows/ci.yml`):

| Check | Pre-commit | CI |
|-------|------------|-----|
| Formatting | `cargo fmt --check` | `cargo fmt --check` |
| Linting | `cargo clippy -D warnings` | `cargo clippy --locked -D warnings` |
| Tests | ❌ Not run | ✅ `cargo test --workspace` |
| Commit format | ✅ Via .githooks | ✅ PR title only |

Pre-commit catches **fast checks** locally. CI runs **complete validation** including tests.

## Performance Tips

1. **Commit frequently with smaller changesets** - Clippy checks scale with changes
2. **Use `--no-verify` sparingly** - Fix issues instead of bypassing
3. **Keep hook environments updated** - Run `pre-commit autoupdate` monthly
4. **Cache is your friend** - First run slow, subsequent runs fast

## Advanced Usage

### Running Hooks in CI

```yaml
# .github/workflows/pre-commit.yml
- uses: pre-commit/action@v3.0.0
```

### Configuring Hook Behavior

Edit `.pre-commit-config.yaml` to:
- Add new hooks
- Change hook arguments
- Update hook versions
- Disable specific hooks (add `exclude: pattern`)

Example - exclude test files from clippy:
```yaml
- id: cargo-clippy
  exclude: ^tests/
```

### Custom Local Hooks

See `TODO-MUST-FIX` hook in `.pre-commit-config.yaml` for example:
```yaml
- repo: local
  hooks:
    - id: detect-todo-must-fix
      name: Detect TODO-MUST-FIX in staged files
      entry: bash -c 'if git diff --cached --name-only | grep -E "\.(rs|ts|js|py)$" | xargs grep -n "TODO-MUST-FIX" 2>/dev/null; then echo "Error: Found TODO-MUST-FIX in staged files. Please address before committing."; exit 1; fi'
      language: system
      pass_filenames: false
```

## Resources

- **Official pre-commit docs**: https://pre-commit.com
- **Freenet-core hook guide**: `docs/PRE_COMMIT_HOOK_GUIDE.md`
- **Hook configuration**: `.pre-commit-config.yaml`
- **Custom clippy script**: `scripts/pre-commit-clippy.sh`
- **Commit message hook**: `.githooks/commit-msg`
- **Conventional Commits**: https://www.conventionalcommits.org
- **Available hooks**: https://pre-commit.com/hooks.html
