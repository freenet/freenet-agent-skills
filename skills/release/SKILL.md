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

**Canonical procedure: [`docs/RELEASING.md`](https://github.com/freenet/freenet-core/blob/main/docs/RELEASING.md) in the freenet-core repo.** Always read that for current details — this section is a summary of the workflow-driven approach that went live with v0.2.58 (#4082, #4114, #4115, #4122, #4123, #4124, #4135, #4136).

The release is driven by `release.yml` on GitHub Actions, not by a local script. Fire it with `gh workflow run`:

```bash
# Routine patch bump (no version input — auto-bumps from crates.io latest):
gh workflow run release.yml --repo freenet/freenet-core

# Explicit version (required for minor / major bumps):
gh workflow run release.yml --repo freenet/freenet-core --field version=X.Y.Z
```

That's all the human has to do. The workflow handles the full cascade:

1. **Validate** - Parse/auto-bump version; warn if `RELEASE_PAT` is unset
2. **Bump PR** - Creates `release/vX.Y.Z` branch, opens auto-merging PR
3. **Wait for PR merge** - Polls until the bump PR lands on main
4. **Publish crates** - `cargo publish` freenet then fdev
5. **Create draft release** - Pushes the `vX.Y.Z` tag, creates a draft GitHub Release
6. **Cross-compile** - Tag push triggers `cross-compile.yml`; builds Linux musl + macOS (Intel + arm64) + Windows + signed DMG
7. **Attach binaries + undraft** - cross-compile uploads 14 artifacts and undrafts the release
8. **Gateway updates** - `release.published` fires `gateway-update.yml`, which signs HMAC-authed `POST /update` to nova (HTTPS) and vega (HTTPS:8443). Workflow polls each gateway's `/version` for 120s
9. **Announcements** - `release.published` also fires `release-announce.yml` → Matrix post + signed POST to nova's `/announce/river` (riverctl runs locally on nova)

### Prerequisites (repo secrets)

| Secret | Used by | Missing → |
|---|---|---|
| `RELEASE_PAT` | release.yml, cross-compile.yml | Bump PR has no CI; `release.published` doesn't fire downstream. Workflow emits `::warning::` |
| `CARGO_REGISTRY_TOKEN` | release.yml | crates.io publish fails |
| `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN` | release-announce.yml | Matrix job warns + skips |
| `RELEASE_AGENT_HMAC_NOVA`, `_VEGA` | gateway-update.yml | gateway POST fails 401 |

`RELEASE_PAT` is a PAT with `repo` + `workflow` scopes — required because GitHub suppresses workflow-triggering events when authenticated by `GITHUB_TOKEN` (anti-recursion safeguard).

### Legacy local script (`scripts/release.sh`)

The local script still exists for dry-runs and emergency manual recovery. To run it without conflicting with the workflow (which would cause duplicate Matrix posts + duplicate SSH gateway updates):

```bash
FREENET_RELEASE_SKIP_ANNOUNCEMENTS=1 \
FREENET_RELEASE_SKIP_GATEWAY_SSH=1 \
./scripts/release.sh --version <VERSION>
```

This is **not** the recommended path for normal releases. Use `gh workflow run release.yml` instead.

## Step 5: Handle Common Issues

**PR title / Conventional Commits check fails:**
Release PRs must use "build:" prefix (not "chore:"). The commit-msg hook only allows: feat, fix, docs, style, refactor, perf, test, build, ci.
```bash
gh api repos/freenet/freenet-core/pulls/XXXX --method PATCH -f title="build: release X.Y.Z"
```

**Auto-merge not triggering:**
- GitHub auto-merge can take 5-10 minutes after checks pass
- The script waits up to 60 minutes (showing progress every 30s)
- Release merge_group entries run the full suite as the pre-publish gate (#3973), so allow 20-30 min for the merge queue to complete
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

## Step 7: Announcements (handled by the workflow)

In the workflow-driven path, **announcements are automatic** — they run as part of `release-announce.yml` when `release.published` fires. The human does not need to send anything manually.

What gets posted:
- **Matrix** (#freenet-locutus channel, `!ygHfYcXtXmivTbOwjX:matrix.org`): one short message with the version + GitHub release URL. TXN_ID is deterministic per version so re-running the workflow against the same version dedupes at Matrix's API layer (no duplicate posts).
- **River** (Freenet Official room): the workflow signs a request to `https://nova.locut.us/release-agent/announce/river`. nova's release-agent invokes `riverctl message send` locally using the room owner signing key (which never leaves nova).

If you want a longer-form announcement with release notes, post it separately — the auto-announcement is intentionally terse.

### Manual override (if the auto-announcement fails)

If `release-announce.yml` failed and you need to re-fire it:

```bash
gh workflow run release-announce.yml --repo freenet/freenet-core --field version=X.Y.Z
```

If only one platform needs manual recovery, the `matrix-comms` and `river-official-room` skills have the direct invocation patterns. Use `-z` for Matrix Markdown rendering. Use `river-official-room` skill first to get the correct Room Owner VK — never hardcode it.

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
- **Release merge_group now runs the full suite as the pre-publish gate** (#3973) — Inverted the previous "skip on release" model. Release detection still keys on the merge_group head_commit message (`build: release*`), which works because the release PR uses squash-merge auto-merge so the PR title becomes the merge_group commit subject. Non-release merge_group entries skip Simulation and NAT Validation (covered by PR-level CI) but keep Unit & Integration. The previous "main CI already validated" justification for skipping on release was wrong — `test_unit`, `test_simulation`, and `nat_validation` are gated to `pull_request | merge_group` only, so push to main never re-validates.
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
