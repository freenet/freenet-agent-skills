# Pre-Commit Hook Setup Instructions

## Quick Setup

Run this command from the root of your freenet-core repository:

```bash
curl -fsSL https://raw.githubusercontent.com/freenet/freenet-agent-skills/main/skills/pre-commit-hooks/references/pre-commit-hook.sh > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Or if you have this repository cloned locally:

```bash
cp /path/to/freenet-agent-skills/skills/pre-commit-hooks/references/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## What the Hook Does

The pre-commit hook runs two checks before allowing a commit:

1. **Code Formatting (`cargo fmt --check`):**
   - Verifies all code follows Rust formatting standards
   - Fails if any file needs formatting
   - Fix with: `cargo fmt`

2. **Clippy Lints (`cargo clippy --all-targets --all-features -- -D warnings`):**
   - Checks all code (including tests) for common issues
   - Treats all warnings as errors
   - Includes all targets: binaries, libraries, tests, examples, benches
   - Fix by addressing the specific warnings clippy reports

## Verification

After setup, verify the hook is installed:

```bash
# Check the hook exists and is executable
ls -l .git/hooks/pre-commit

# Test it by making a dummy commit
git commit --allow-empty -m "test hook"
```

You should see output like:
```
Running pre-commit checks...
Checking code formatting...
Running clippy on all targets...
✅ All pre-commit checks passed!
```

## Usage Examples

### Normal workflow (hook runs automatically)

```bash
# Make changes
vim src/some_file.rs

# Format code
cargo fmt

# Stage changes
git add src/some_file.rs

# Commit (hook runs automatically)
git commit -m "fix: improve error handling"
```

### If the hook catches formatting issues

```
$ git commit -m "fix: something"
Running pre-commit checks...
Checking code formatting...
Diff in /path/to/file.rs at line 42:
❌ Code formatting check failed!
Run 'cargo fmt' to fix formatting issues.
```

Fix it:
```bash
cargo fmt
git add -u
git commit -m "fix: something"
```

### If the hook catches clippy warnings

```
$ git commit -m "feat: new feature"
Running pre-commit checks...
Checking code formatting...
Running clippy on all targets...
warning: unused variable: `foo`
  --> src/lib.rs:10:9
❌ Clippy check failed!
Fix the warnings above before committing.
```

Fix it:
```bash
# Fix the issue in your editor
vim src/lib.rs

git add src/lib.rs
git commit -m "feat: new feature"
```

## Worktree Setup

If you use git worktrees (recommended for freenet-core), set up the hook in each worktree:

```bash
# In main worktree
cd ~/code/freenet/freenet-core/main
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# In feature branch worktree
cd ~/code/freenet/freenet-core/fix-123
cp /path/to/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Bypassing the Hook

In exceptional cases, you can bypass the hook:

```bash
git commit --no-verify -m "your message"
```

**Warning:** Only use this when absolutely necessary. The hooks catch issues that will cause CI failures.

## Troubleshooting

### Hook doesn't run

1. Check if it's executable:
   ```bash
   ls -l .git/hooks/pre-commit
   # Should show: -rwxr-xr-x
   ```

2. Make it executable if needed:
   ```bash
   chmod +x .git/hooks/pre-commit
   ```

### Cargo commands not found

Ensure you're in the repository root:
```bash
pwd  # Should be in freenet-core directory
ls Cargo.toml  # Should exist
```

### Hook runs slowly

The clippy check can take time on first run. Subsequent runs are faster due to caching.

### Want to customize the hook

Edit `.git/hooks/pre-commit` directly. For example, to skip clippy:

```bash
# Comment out the clippy section
# if ! cargo clippy --all-targets --all-features -- -D warnings; then
#     ...
# fi
```

## CI Alignment

The hook runs the same checks as CI:
- CI formatting check: `cargo fmt --check`
- CI lint check: `cargo clippy --all-targets --all-features -- -D warnings`

This ensures your commits will pass CI's automated checks.
