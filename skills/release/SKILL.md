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

## Step 0: Set Up Tab Context

Capture the current tmux window ID and rename it. The window ID is stable even if the user switches tabs during the long-running release, so always use `-t` with the saved ID for subsequent renames.

```bash
RELEASE_WINDOW=$(tmux display-message -p '#{window_id}')
tmux rename-window -t "$RELEASE_WINDOW" "release X.Y.Z"
```

Replace `X.Y.Z` with the target version (determine it first if auto-detecting). Keep `$RELEASE_WINDOW` available for Step 8 (success criteria).

## Step 1: Determine Current State

**First, pull the latest changes from origin.** Without this, you may see zero commits since the last tag and incorrectly conclude there's nothing to release.

```bash
# Pull latest — MUST do this before anything else
git pull origin main

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
# Must be on main branch (or a release worktree)
git branch --show-current

# Must have clean working directory
git status --porcelain  # Should be empty

# Must be up to date with origin
git fetch origin main
git rev-parse HEAD  # Compare with:
git rev-parse origin/main
```

If any check fails, inform the user and stop.

### Optional: Create a Release Worktree

To avoid disrupting the main worktree:

```bash
cd ~/code/freenet/freenet-core/main  # or wherever main worktree is
git worktree add -b release-work ../release-X.Y.Z
cd ../release-X.Y.Z
```

Clean up after release:
```bash
git worktree remove ../release-X.Y.Z
git branch -d release-work
```

## Step 4: Run the Release

**CRITICAL: You MUST run `release.sh` as a single command. Do NOT manually execute individual release steps (gh release create, cargo publish, etc.).** The script handles draft releases, binary waits, and publish ordering that prevent users from seeing a version before its binaries exist. Doing steps manually caused a user-facing 404 during v0.1.177.

Execute the release script:

```bash
./scripts/release.sh --version <VERSION> [--skip-tests]
```

The script handles the entire pipeline:
1. **Version bump** - Updates `crates/core/Cargo.toml` and `crates/fdev/Cargo.toml`
2. **Release PR** - Creates a branch, commits, pushes, opens PR with auto-merge
3. **Wait for CI** - Monitors GitHub CI on the release PR (up to 30 min)
4. **Publish crates** - Publishes `freenet` then `fdev` to crates.io
5. **GitHub Release** - Creates tag, generates release notes, creates **draft** release
6. **Cross-compile** - Triggered automatically by the tag push
7. **Wait for binaries** - Waits for cross-compile to attach binaries to the release
8. **Publish draft** - Publishes the draft release only after binaries are attached
9. **Gateway updates** - SSHes into all gateways and triggers immediate update
10. **Announcements** - Matrix and River notifications (if tools available)

### Important Options

- `--skip-tests` - Skip local pre-release tests (CI still runs on the PR)
- `--dry-run` - Show what would be done without executing

### Resumability

The release script is **resumable**. If it fails partway through, re-running with the same `--version` will auto-detect completed steps and skip them. State is saved to `/tmp/release-<VERSION>.state`.

You can also resume explicitly: `./scripts/release.sh --resume /tmp/release-<VERSION>.state`

### Branch Safety

The script automatically restores the original git branch on exit (success or failure). If the script is interrupted, your working directory won't be left on the `release/v*` branch.

### CI Wait Behavior

- **Main CI check**: If main branch CI is still running when the script starts, it polls every 30s (up to 10 min) instead of exiting immediately
- **PR merge wait**: Polls every 30s (up to 30 min) for the PR to pass CI and auto-merge
- **Merge queue optimization**: Release PRs skip expensive tests (Unit & Integration, Simulation, NAT Validation) in the merge queue since main CI already validated the code. This reduces merge queue time from ~6 min to ~1 min.

## Step 5: Handle Common Issues

**PR title / Conventional Commits check fails:**
Release PRs must use "build:" prefix (not "chore:"). The commit-msg hook only allows: feat, fix, docs, style, refactor, perf, test, build, ci.
```bash
gh api repos/freenet/freenet-core/pulls/XXXX --method PATCH -f title="build: release X.Y.Z"
```

**Auto-merge not triggering:**
- GitHub auto-merge can take 5-10 minutes after checks pass
- The script waits up to 30 minutes (showing progress every 30s)
- Release PRs skip expensive tests in the merge queue (commit message detection), so merge queue should complete in ~1 min
- You can manually merge the PR — the script detects manual merges and continues

**Test failures:**
Check CI logs. Either fix the issue or inform the user and ask how to proceed.

## Step 6: Verify Release Artifacts

**CRITICAL: Do NOT announce until cross-compile binaries are available.** The `Build and Cross-Compile` workflow triggers on tag push and takes ~15-20 min to build binaries for all platforms. Gateway auto-update depends on these binaries.

```bash
# Check crates.io publication
cargo search freenet --limit 1

# Check GitHub release exists
gh release view v<VERSION>

# Verify ALL required platform binaries are attached
gh release view v<VERSION> --json assets --jq '.assets[].name'
```

**Required platform binaries** (all must be present):
- `freenet-x86_64-unknown-linux-musl.tar.gz`
- `freenet-aarch64-unknown-linux-musl.tar.gz`
- `freenet-aarch64-apple-darwin.tar.gz`
- `freenet-x86_64-apple-darwin.tar.gz`
- `freenet-x86_64-pc-windows-msvc.zip`
- `fdev-x86_64-unknown-linux-musl.tar.gz`
- `fdev-aarch64-unknown-linux-musl.tar.gz`
- `fdev-aarch64-apple-darwin.tar.gz`
- `fdev-x86_64-apple-darwin.tar.gz`
- `fdev-x86_64-pc-windows-msvc.zip`
- `freenet.exe`
- `SHA256SUMS.txt`

If any binary is missing, **do not proceed to announcements**. Investigate the cross-compile workflow failure first.

```bash
# Monitor cross-compile workflow if binaries not yet available
gh run list --workflow=cross-compile.yml --limit 3
```

## Step 6.5: Smoke Test River Compatibility

**Before announcing, verify that River clients can still talk to the gateway.** Protocol changes (new message variants, streaming defaults, serialization changes) can silently break River even when all freenet-core tests pass.

```bash
cd /home/ian/code/freenet/river/main
cargo run -p riverctl -- member list 4uNUKFzZQCnzo4K2ecZ16cMsYEEfoaRS35z6exEsbvm4
```

This GETs the official room state from the gateway and deserializes it. If it fails:
- **STOP — do not announce the release**
- The failure likely means a protocol or serialization change broke River client compatibility
- Check if River's freenet-stdlib dependency needs updating to match the new release
- Fix the issue before proceeding to announcements

**Why this matters:** During v0.2.11, enabling WebSocket streaming by default broke riverctl because it was pinned to an older stdlib that couldn't deserialize the new `StreamHeader`/`StreamChunk` variants. This smoke test would have caught that before users were affected.

## Step 7: Announcements

Only after binaries are confirmed available. Use the `matrix-comms` and `river-official-room` skills for detailed instructions on each platform.

**Announcement content:** Write a 1-3 sentence Markdown summary of the key changes in this release, followed by a link to the GitHub release for full details. Both Matrix and River support Markdown formatting.

**Example format:**
```
**Freenet v0.1.177 released.** Transient WebSocket errors no longer kill the client slot permanently. See [release notes](https://github.com/freenet/freenet-core/releases/tag/v0.1.177) for details.
```

**Matrix** (#freenet-locutus channel) — use the `matrix-comms` skill:
```bash
# -z flag is REQUIRED for Markdown rendering (bold, links, etc.)
timeout 30 matrix-commander -z -r "!ygHfYcXtXmivTbOwjX:matrix.org" -m "announcement text"
```

**River** (Freenet Official room) — use the `river-official-room` skill:

**IMPORTANT:** You MUST invoke the `river-official-room` skill first to get the correct Room Owner VK and identity restoration instructions. The Room Owner identity must be restored before sending messages. Do NOT hardcode the VK here — it changes when the room is recreated.

```bash
# 1. Restore Room Owner identity (see river-official-room skill for current VK and key location)
# 2. Send message using the VK from the skill
cd /home/ian/code/freenet/river/main
cargo run -p riverctl -- message send <ROOM_OWNER_VK> "announcement text"
```

## Step 8: Post-Release Verification

**A release is NOT complete until the network is verified healthy.**

Wait 10-15 minutes for gateways to auto-update, then verify:

1. **Gateway versions updated** — Check that gateways are running the new version
2. **Gateway logs clean** — No new errors, warnings, panics, or log spam
3. **Network health** — Peers connecting, contracts propagating, subscriptions working

If you have access to gateway machines, check logs directly. If you have access to telemetry, monitor network-wide health. The specific verification steps depend on your access level — see your local environment's release skill for machine-specific commands.

**What to look for:**
- **Log spam** — Same message repeating hundreds of times (can fill disks within hours)
- **Rapid log growth** — Normal is ~1MB/hour; much faster indicates a problem
- **New error patterns** — Errors not present before the release
- **Connection failures** — "connection refused", "timeout", "handshake failed"
- **Resource issues** — "out of memory", "no space left", "too many open files"

**If critical issues found:** Roll back immediately, create GitHub issue, announce rollback.

## Rollback

If a release needs to be rolled back:

```bash
# Rollback (keeps crates.io versions)
./scripts/release-rollback.sh --version <VERSION>

# Rollback and yank from crates.io (irreversible!)
./scripts/release-rollback.sh --version <VERSION> --yank-crates

# Dry run
./scripts/release-rollback.sh --version <VERSION> --dry-run
```

## Version Scheme

- **freenet:** `0.1.X` - patch incremented each release
- **fdev:** `0.3.X` - patch auto-incremented by release script (independent versioning)

## Incident Learnings

These are real issues from past releases that the release process has been hardened against:

- **"Text file busy" during deployment** — Deploy script now disables systemd auto-restart, waits for binary release, re-enables after
- **PR title must use "build:" prefix** — Changed from "chore:" to comply with commit-msg hook
- **Matrix announcements can hang** — matrix-send wrapper has 20s timeout and 3 retries; matrix-commander handles E2E encryption that raw curl cannot
- **PATH shadowing** — Old `cargo install freenet` may leave stale binary at `~/.cargo/bin/freenet` shadowing `/usr/local/bin/freenet`; always use absolute paths when verifying versions
- **Binary vs running process mismatch** — Deploying a new binary doesn't mean the service is running it; verify via `systemctl show -p MainPID` + `/proc/PID/exe`, not just binary on disk
- **Don't announce before binaries exist** — Cross-compile takes 15-20 min; gateway auto-update (especially aarch64) depends on release binaries being attached
- **Log spam can fill disks** — Always review logs 10-15 min after release; previous releases introduced logging that consumed disk space within hours
- **Merge queue ran full CI for release PRs** — `github.head_ref` is a queue branch in merge_group events, not the PR branch. Fixed by detecting release PRs via commit message (`build: release*`) and skipping expensive test steps
- **Script left user on release branch** — Added EXIT trap to restore original branch on any exit
- **Streaming default broke riverctl** — v0.2.11 enabled WebSocket streaming by default, but riverctl was pinned to stdlib 0.1.40 which couldn't deserialize `StreamHeader`/`StreamChunk` variants. Always smoke-test River CLI against the gateway before announcing.

## Gateway Updates

The release script automatically SSHes into all known gateways and triggers `gateway-auto-update.sh --force` immediately after cross-compile binaries are available. This eliminates the 10-minute polling delay that previously caused version mismatch issues (users installing the new version before gateways updated).

Gateways also have a 10-minute polling timer as a fallback. Peers self-update when they detect a version mismatch with the gateway (exit code 42), which triggers `freenet update` automatically.

## Success Criteria

Release is complete when:
- ✓ PR merged to main
- ✓ Published to crates.io
- ✓ GitHub release created with tag and binaries attached
- ✓ Gateways updated to new version
- ✓ Matrix announcement sent
- ✓ River announcement sent
- ✓ Network verified healthy post-release (logs clean, telemetry normal)

Once ALL criteria are met (including post-release monitoring), mark the release as complete using the window ID captured in Step 0:

```bash
tmux rename-window -t "$RELEASE_WINDOW" "✓ release X.Y.Z"
```
