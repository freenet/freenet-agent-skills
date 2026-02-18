---
name: release
description: Orchestrate a new Freenet release. Determines next version, shows changelog, confirms with user, and runs the release pipeline. Use when the user says "do a release", "new release", "release", or "/release".
user_invocable: true
license: LGPL-3.0
---

# Freenet Release Skill

## Overview

This skill orchestrates a complete Freenet release. It determines the next version, shows what's changed since the last release, confirms with the user, and runs the automated release pipeline.

## Arguments

- If an argument is provided (e.g., `/release 0.1.133`), use that as the target version
- If no argument is provided, auto-detect the next patch version

## Step 1: Determine Current State

Run these commands to gather release context:

```bash
# Get current version from Cargo.toml
grep "^version" crates/core/Cargo.toml | cut -d'"' -f2

# Get the last release tag
git describe --tags --abbrev=0

# Get commits since last release
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

**Auto-version logic:** If no version argument was provided, increment the patch version of the current version (e.g., `0.1.132` -> `0.1.133`).

## Step 2: Show Changelog and Confirm

Present the user with:
1. **Current version** and **target version**
2. **Commits since last release** (categorized by conventional commit type)
3. **fdev version** that will be auto-incremented

Then ask the user to confirm before proceeding.

## Step 3: Pre-flight Checks

Before running the release script, verify:

```bash
# Must be on main branch
git branch --show-current  # Should be "main"

# Must have clean working directory
git status --porcelain  # Should be empty

# Must be up to date with origin
git fetch origin main
git rev-parse HEAD  # Compare with:
git rev-parse origin/main
```

If any check fails, inform the user and stop.

## Step 4: Run the Release

Execute the release script:

```bash
./scripts/release.sh --version <VERSION>
```

The script handles the entire pipeline:
1. **Version bump** - Updates `crates/core/Cargo.toml` and `crates/fdev/Cargo.toml`
2. **Release PR** - Creates a branch, commits, pushes, opens PR with auto-merge
3. **Wait for CI** - Monitors GitHub CI on the release PR (up to 30 min)
4. **Publish crates** - Publishes `freenet` then `fdev` to crates.io
5. **GitHub Release** - Creates tag, generates release notes, creates release
6. **Cross-compile** - Triggered automatically by the tag push
7. **Announcements** - Matrix and River notifications (if tools available)

### Important Options

- `--skip-tests` - Skip local pre-release tests (CI still runs on the PR)
- `--dry-run` - Show what would be done without executing
- `--deploy-local` - Deploy to local gateway after release
- `--deploy-remote` - Deploy to remote gateways after release

### Resumability

The release script is **resumable**. If it fails partway through, re-running with the same `--version` will auto-detect completed steps and skip them. State is saved to `/tmp/release-<VERSION>.state`.

## Step 5: Post-Release Verification

After the release completes, verify:

```bash
# Check crates.io publication
cargo search freenet --limit 1

# Check GitHub release exists
gh release view v<VERSION>

# Check cross-compile workflow started
gh run list --workflow=cross-compile.yml --limit 1
```

## Step 6: Post-Release Log Review

**IMPORTANT:** Wait 10-15 minutes for gateways to auto-update, then check logs:

```bash
# Check gateway logs for errors
ssh freenet@nova.locut.us 'freenet --version && tail -100 ~/.local/state/freenet/freenet.$(date +%Y-%m-%d).log | grep -iE "error|warn" | tail -10'
ssh freenet@vega.locut.us 'freenet --version && tail -100 ~/.local/state/freenet/freenet.$(date +%Y-%m-%d).log | grep -iE "error|warn" | tail -10'
ssh ian@technic 'freenet --version && tail -100 ~/.local/state/freenet/freenet.$(date +%Y-%m-%d).log | grep -iE "error|warn" | tail -10'
```

Look for: log spam, rapid log growth, new error patterns.

## Rollback

If a release needs to be rolled back:

```bash
./scripts/release-rollback.sh --version <VERSION>
# Add --yank-crates to also yank from crates.io (irreversible!)
```

## Version Scheme

- **freenet:** `0.1.X` - patch incremented each release
- **fdev:** `0.3.X` - patch auto-incremented by release script (independent versioning)
