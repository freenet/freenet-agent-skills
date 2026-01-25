---
name: pre-commit-hooks
description: Sets up Git pre-commit hooks for freenet-core using their official pre-commit framework configuration that runs cargo fmt, clippy, and other checks
license: LGPL-3.0
---

# Freenet Core Pre-Commit Hooks

This skill helps you set up the official pre-commit hooks for freenet-core using the **pre-commit framework** (https://pre-commit.com).

## What freenet-core Uses

The freenet-core repository uses the official **pre-commit framework** with a comprehensive `.pre-commit-config.yaml` configuration file that runs:

### Rust Checks
1. **`cargo fmt`** - Enforces consistent code formatting
2. **Smart Clippy** - Custom script (`scripts/pre-commit-clippy.sh`) that:
   - Only lints Rust packages with modified files (performance optimization)
   - Treats all warnings as errors (`-D warnings`)
   - Includes special handling for the "freenet" package with `--features bench`

### Standard Checks
3. **Merge conflict detection** - Prevents accidental merge conflict markers
4. **YAML syntax validation** - Ensures YAML files are valid
5. **End-of-file fixing** - Ensures files end with newline
6. **Trailing whitespace removal** - Cleans up whitespace

### Custom Checks
7. **TODO-MUST-FIX blocker** - Blocks commits containing "TODO-MUST-FIX" markers in `.rs`, `.ts`, `.js`, and `.py` files

### Commit Message Validation
The `.githooks/commit-msg` hook enforces **Conventional Commits** format:
- Required format: `type(scope): description`
- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`

## Setup Instructions

### 1. Install pre-commit Framework

**Using pip:**
```bash
pip install pre-commit
```

**Using Homebrew (macOS):**
```bash
brew install pre-commit
```

**Using asdf:**
```bash
asdf plugin add pre-commit
asdf install pre-commit latest
asdf global pre-commit latest
```

### 2. Install Hooks in Repository

```bash
cd /path/to/freenet-core
pre-commit install
```

This creates `.git/hooks/pre-commit` that runs the configured checks.

### 3. (Optional) Install Commit Message Hook

```bash
git config core.hooksPath .githooks
```

This enables Conventional Commits validation for commit messages.

### 4. Verify Installation

```bash
# Test on staged files
pre-commit run

# Test on all files
pre-commit run --all-files
```

## Usage

### Normal Workflow

The hooks run automatically on `git commit`:

```bash
# Make changes
vim src/some_file.rs

# Stage changes
git add src/some_file.rs

# Commit (hooks run automatically)
git commit -m "fix: improve error handling"
```

### If Checks Fail

**Formatting failures:**
```bash
cargo fmt
git add -u
git commit -m "your message"
```

**Clippy warnings:**
Fix the specific issues reported, then:
```bash
git add .
git commit -m "your message"
```

**TODO-MUST-FIX detected:**
Remove or address the TODO-MUST-FIX markers before committing.

**Commit message format errors:**
Use the correct Conventional Commits format: `type(scope): description`

### Bypassing Hooks (Emergency Only)

```bash
git commit --no-verify -m "your message"
```

**Warning:** Only use `--no-verify` in exceptional circumstances. The repository has these hooks for good reasons.

### Manual Execution

```bash
# Run on staged files only
pre-commit run

# Run on all files in repository
pre-commit run --all-files

# Run specific hook
pre-commit run cargo-fmt
pre-commit run cargo-clippy
```

## Benefits

- **Optimized performance**: Smart clippy script only checks modified packages
- **Catch issues early**: Find problems before CI
- **Faster CI**: Reduce CI failures from simple formatting/lint issues
- **Enforced standards**: Conventional Commits, no TODO-MUST-FIX markers
- **Framework-managed**: Updates and improvements handled via config file

## Worktree Setup

If using git worktrees (recommended for freenet-core):

```bash
# Set up in each worktree
cd ~/code/freenet/freenet-core/main
pre-commit install

cd ~/code/freenet/freenet-core/fix-123
pre-commit install
```

## CI Alignment

The pre-commit hooks mirror CI checks in `.github/workflows/ci.yml`:

**Pre-commit runs:**
- `cargo fmt --check`
- `cargo clippy -- -D warnings` (smart per-package)
- YAML validation
- TODO-MUST-FIX detection

**CI runs:**
- `cargo fmt --check`
- `cargo clippy --locked -- -D warnings`
- Conventional Commits validation (for PR titles)
- Full test suite

By catching issues locally, you avoid the cycle of: push → CI fails → fix → push again.

## Troubleshooting

### Hooks don't run

Check installation:
```bash
ls -l .git/hooks/pre-commit
cat .git/hooks/pre-commit  # Should reference pre-commit framework
```

Re-install if needed:
```bash
pre-commit install
```

### pre-commit command not found

The framework isn't installed. See installation instructions above.

### Hooks run slowly

First run is slow (downloads hook environments). Subsequent runs are cached and fast.

To update hook environments:
```bash
pre-commit clean
pre-commit install-hooks
```

### Want to skip specific hooks

Set environment variable:
```bash
SKIP=cargo-clippy git commit -m "message"
```

### Update hooks to latest versions

```bash
pre-commit autoupdate
```

## Documentation

For complete details, see the official freenet-core documentation:
- **`docs/PRE_COMMIT_HOOK_GUIDE.md`** - Full guide with examples and troubleshooting
- **`.pre-commit-config.yaml`** - Hook configuration
- **`scripts/pre-commit-clippy.sh`** - Custom clippy implementation
- **`.githooks/commit-msg`** - Commit message validation

## References

- Pre-commit Framework: https://pre-commit.com
- Conventional Commits: https://www.conventionalcommits.org
- freenet-core repository: https://github.com/freenet/freenet-core
