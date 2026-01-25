---
name: pre-commit-hooks
description: Sets up Git pre-commit hooks for freenet-core that automatically run cargo fmt and cargo clippy (including test targets) before each commit
license: LGPL-3.0
---

# Freenet Core Pre-Commit Hooks

This skill helps you set up automated pre-commit hooks for the freenet-core repository that ensure code quality before committing.

## What Gets Checked

Before each commit, the following commands run automatically:

1. **`cargo fmt --check`** - Ensures code is properly formatted
2. **`cargo clippy --all-targets --all-features -- -D warnings`** - Checks for lints on all targets (including tests) and treats warnings as errors

If either check fails, the commit is blocked and you'll see the errors that need to be fixed.

## Setup Instructions

### Automatic Setup

When working in a freenet-core repository, this skill can automatically set up the pre-commit hook for you. Just ask:

```
"Set up pre-commit hooks for this repository"
```

### Manual Setup

If you prefer to set it up manually:

1. Navigate to your freenet-core repository
2. Create the hook file:
   ```bash
   cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
#
# Pre-commit hook for freenet-core
# Runs cargo fmt and cargo clippy before allowing commits
#

set -e

echo "Running pre-commit checks..."

# Check formatting
echo "Checking code formatting..."
if ! cargo fmt --check; then
    echo "❌ Code formatting check failed!"
    echo "Run 'cargo fmt' to fix formatting issues."
    exit 1
fi

# Run clippy on all targets (including tests)
echo "Running clippy on all targets..."
if ! cargo clippy --all-targets --all-features -- -D warnings; then
    echo "❌ Clippy check failed!"
    echo "Fix the warnings above before committing."
    exit 1
fi

echo "✅ All pre-commit checks passed!"
EOF
   chmod +x .git/hooks/pre-commit
   ```

## Using the Hook

Once installed, the hook runs automatically before every commit.

### If Checks Fail

**Formatting failures:**
```bash
cargo fmt
git add .
git commit -m "your message"
```

**Clippy failures:**
Fix the issues reported by clippy, then:
```bash
git add .
git commit -m "your message"
```

### Bypassing the Hook (Not Recommended)

In rare cases where you need to commit without running the checks:
```bash
git commit --no-verify -m "your message"
```

**Warning:** Only use `--no-verify` in exceptional circumstances. The hooks exist to catch issues before they reach CI.

## Benefits

- **Catch issues early**: Find formatting and lint issues locally before pushing
- **Faster CI**: Reduce CI failures from simple fmt/clippy issues
- **Consistent code quality**: Ensure all commits meet the project's standards
- **Save time**: Avoid the cycle of push → CI fails → fix → push again

## Troubleshooting

### Hook doesn't run

Check if the hook file is executable:
```bash
ls -l .git/hooks/pre-commit
```

If not, make it executable:
```bash
chmod +x .git/hooks/pre-commit
```

### Hook runs but cargo commands fail

Ensure you're in the repository root where Cargo.toml exists:
```bash
pwd  # Should be in freenet-core directory
ls Cargo.toml  # Should exist
```

### Want to update the hook

Just re-run the setup commands above - they'll overwrite the existing hook file.

## Integration with Worktrees

If you're using git worktrees (recommended for freenet-core development), you'll need to set up the hook in each worktree:

```bash
cd ~/code/freenet/freenet-core/main
# Set up hook in main worktree

cd ~/code/freenet/freenet-core/fix-123
# Set up hook in fix-123 worktree
```

## CI Alignment

These hooks run the same checks that CI runs, ensuring your commits will pass the automated checks:
- CI runs `cargo fmt --check`
- CI runs `cargo clippy --all-targets --all-features -- -D warnings`

By running these locally first, you minimize CI failures and speed up the development cycle.
