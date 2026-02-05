#!/bin/bash
#
# Claude Code PreToolUse hook for Rust projects
# Runs cargo fmt and cargo clippy before allowing git commits
#
# This script is called by Claude Code's hook system before Bash tool execution.
# It receives the tool input as JSON via STDIN.
#
# Usage in hooks.json:
#   {
#     "hooks": {
#       "PreToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "./hooks/claude-pre-commit-hook.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
#

# Prevent infinite recursion - if we're already running a hook, skip
if [[ -n "$FREENET_HOOK_RUNNING" ]]; then
    exit 0
fi

# Read the tool input from STDIN
input=$(cat)

# Extract the command being executed
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Only run checks for git commit commands in Rust projects
if [[ "$command" == *"git commit"* ]] && [[ -f Cargo.toml ]]; then
    echo "🔍 Running pre-commit checks..."

    # Set flag to prevent recursion
    export FREENET_HOOK_RUNNING=1

    # Check formatting
    if ! cargo fmt --check 2>&1; then
        echo "❌ Formatting check failed. Run: cargo fmt"
        exit 1
    fi

    # Run clippy
    if ! cargo clippy --all-targets --all-features -- -D warnings 2>&1; then
        echo "❌ Clippy check failed. Fix warnings above."
        exit 1
    fi

    echo "✅ Pre-commit checks passed"
fi
