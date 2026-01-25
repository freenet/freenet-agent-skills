#!/bin/bash
#
# Pre-commit hook for Rust projects (freenet-core)
# Runs cargo fmt and cargo clippy before allowing commits
#
# Installation:
#   cp pre-commit-hook.sh /path/to/repo/.git/hooks/pre-commit
#   chmod +x /path/to/repo/.git/hooks/pre-commit
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
