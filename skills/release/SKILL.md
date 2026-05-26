---
name: release
description: Orchestrate a new Freenet release. Determines next version, shows changelog, confirms with user, and triggers the release pipeline via GitHub Actions. Use when the user says "do a release", "new release", "release", or "/release".
user_invocable: true
license: LGPL-3.0
---

# Freenet Release Skill

## Overview

This skill orchestrates a complete Freenet release. The release pipeline runs entirely in GitHub Actions — your job is to determine the version, confirm with the user, trigger the workflow, watch it complete, then verify the cascade (gateway updates, announcements, network health).

The workflow handles all of: version bump → release PR → CI gate → crates.io publish → GitHub release → cross-compile binaries. The `release.published` event then auto-triggers `gateway-update.yml` (HMAC-POSTs each gateway's release-agent) and `release-announce.yml` (Matrix + River posts via release-agent).

## Arguments

- If an argument is provided (e.g., `/release 0.2.65`), use it as the target version.
- If no argument is provided, auto-detect: increment the patch of the version currently in `crates/core/Cargo.toml`. If unreleased PRs have already bumped it past the last tag, **use the current Cargo.toml version as-is** rather than incrementing again — that's the version those PRs were intended for.

## Step 1: Determine Version and Show Changelog

```bash
cd ~/code/freenet/freenet-core/main
git pull origin main                                           # MUST pull first
LAST_TAG=$(git describe --tags --abbrev=0)
CARGO_VERSION=$(grep "^version" crates/core/Cargo.toml | cut -d'"' -f2)
echo "Last release tag: $LAST_TAG"
echo "Cargo.toml says:  $CARGO_VERSION"
echo
echo "Commits since $LAST_TAG:"
git log --oneline "$LAST_TAG"..HEAD
```

Pick the target version (see Arguments above). Present the user with current version, target version, and a categorized changelog. **Confirm before triggering.**

## Step 2: Trigger the Release Workflow

```bash
gh workflow run release.yml --repo freenet/freenet-core --field version=X.Y.Z
```

Available inputs (see `gh workflow view release.yml --yaml`):
- `version` — required for explicit version; leave blank to auto-patch-bump from the latest crates.io release.
- `skip_tests` — skip pre-release local tests (CI still runs on the PR).
- `dry_run` — show what would happen without publishing.

Confirm the run started:

```bash
sleep 5
gh run list --workflow release.yml --repo freenet/freenet-core --limit 1 \
    --json databaseId,status,event,createdAt
```

## Step 3: Watch the Release Run

The workflow takes ~20–30 minutes (version-bump → release PR → merge_group full-suite CI → crates.io → GitHub release → cross-compile binaries). Use `gh run watch` in a backgrounded `Bash` call so the harness notifies on completion — never manually poll.

```bash
RUN_ID=$(gh run list --workflow release.yml --repo freenet/freenet-core --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --repo freenet/freenet-core --interval 30 --exit-status
```

If the run fails, inspect the failing job:

```bash
gh run view "$RUN_ID" --repo freenet/freenet-core --log-failed | tail -100
```

Common failure modes are below (Step 5).

## Step 4: Verify the Release Artifacts

After the release workflow succeeds, the `release.published` event fires and the downstream cascade runs automatically. Verify each piece landed:

```bash
VER=X.Y.Z

# crates.io
cargo search freenet --limit 1                                  # should show new version
cargo search fdev --limit 1                                     # should show bumped fdev

# GitHub release + binaries
gh release view "v$VER" --repo freenet/freenet-core
gh release view "v$VER" --repo freenet/freenet-core --json assets --jq '.assets[].name'
```

**Required platform binaries** (all must be attached before the cascade is healthy):

- `freenet-x86_64-unknown-linux-musl.tar.gz`
- `freenet-aarch64-unknown-linux-musl.tar.gz`
- `freenet-x86_64-apple-darwin.tar.gz`
- `freenet-aarch64-apple-darwin.tar.gz`
- `freenet-x86_64-pc-windows-msvc.zip`
- `freenet.exe`
- corresponding `fdev-*` archives
- `SHA256SUMS.txt`

Check the downstream cascade fired (these auto-trigger on `release.published`):

```bash
gh run list --workflow gateway-update.yml --repo freenet/freenet-core --limit 1
gh run list --workflow release-announce.yml --repo freenet/freenet-core --limit 1
```

Both should show recent runs initiated after the release. If either is missing, the `RELEASE_PAT` secret may have expired (see freenet-core's AGENTS.md "Release Workflow & RELEASE_PAT" section).

## Step 5: River Compatibility Smoke Test

Before relying on the auto-announcements, verify River clients can still talk to the gateway. Protocol changes (new wire variants, streaming defaults, serialization changes) can silently break River even when all freenet-core tests pass.

The current Freenet Official room owner VK lives in the `river-official-room` skill — do NOT hardcode it here; it rotates when the room is recreated.

```bash
ROOM_VK=$(...)  # from river-official-room skill
cd ~/code/freenet/river/main
cargo run -p riverctl -- member list "$ROOM_VK"
```

If this fails with a bincode deserialization error: **STOP.** A protocol or serialization change broke River compatibility. Roll back the release (see "Rollback" below), file an issue, and rebuild River against the new stdlib before retrying.

(v0.2.11 incident: enabling WebSocket streaming by default broke riverctl pinned to stdlib 0.1.40 — `StreamHeader`/`StreamChunk` variants weren't deserializable. This smoke test catches that class of regression.)

## Step 6: Post-Release Network Verification

Wait 10–15 min for gateways to auto-update via the release-agent HMAC POST, then verify:

1. **Gateway versions** — each gateway is running the new version. Use the `freenet-gateway-ops` skill for SSH'd version + log checks on nova / vega / technic.
2. **Gateway logs clean** — no new error patterns, no rapid log growth (normal is ~1 MB/h; faster signals a problem).
3. **Network health** — telemetry shows peers connecting, contracts propagating, subscriptions working. Use `freenet-telemetry-monitor` for raw event queries or `freenet-telemetry-dashboard` for the live view.

Watch for:

- **Log spam** — same message repeating hundreds of times (can fill disks within hours).
- **New error patterns** — errors not present before the release.
- **Connection failures** — `connection refused`, `timeout`, `handshake failed`.
- **Resource issues** — `out of memory`, `no space left`, `too many open files`.

If a critical issue surfaces: **roll back immediately**, create a GitHub issue with the symptom + logs, post a rollback notice via the release-announce path or Matrix manually.

## Rollback

The rollback script is still the right tool for un-doing a release:

```bash
cd ~/code/freenet/freenet-core/main
./scripts/release-rollback.sh --version <VERSION>             # keeps crates.io
./scripts/release-rollback.sh --version <VERSION> --yank-crates  # irreversible
./scripts/release-rollback.sh --version <VERSION> --dry-run
```

## Common Workflow Failures

- **PR title fails Conventional Commits.** The release workflow opens its own PR with title `build: release X.Y.Z`. If the commit-msg hook is enforced differently in CI, patch via `gh api repos/freenet/freenet-core/pulls/<PR> --method PATCH -f title="build: release X.Y.Z"`.
- **Merge queue stuck on the release PR.** Release `merge_group` entries run the full suite (Unit & Integration, Simulation, NAT Validation) as the pre-publish gate (#3973). Expect 20–30 min. Non-release merge_group entries skip Simulation and NAT Validation, so this is the only place those run against the rebased commit — don't manually merge to skip.
- **Cascade didn't fire after `release.published`.** Suggests `RELEASE_PAT` is missing or expired. `release.yml` emits a `::warning::` when the secret is absent; check the workflow logs and rotate the PAT per AGENTS.md. As a manual fallback: `gh workflow run gateway-update.yml --field version=X.Y.Z` and `gh workflow run release-announce.yml --field version=X.Y.Z`.
- **Cross-compile attached partial binaries.** Some platforms can fail independently. `gh run view <cross-compile run-id> --log-failed` shows which target failed. Re-run that single platform via `gh workflow run cross-compile.yml`.

## Version Scheme

- **freenet:** `0.2.X` — patch incremented each release.
- **fdev:** `0.3.X` — patch auto-incremented by the workflow (independent versioning).

## Incident Learnings

Recurring issues the pipeline has been hardened against:

- **Don't manually run individual release steps** (`cargo publish`, `gh release create`, `gh release edit`). The workflow handles draft releases and binary waits so users never see a version before its binaries exist. Doing steps by hand caused a user-facing 404 during v0.1.177.
- **Don't announce before binaries exist.** Cross-compile takes 15–20 min; gateway auto-update (especially aarch64) depends on the binaries being attached. The `release-announce.yml` and `gateway-update.yml` cascade triggers on `release.published`, which fires only after binaries are attached, so this is automatic — but if you're manually re-triggering announcements, check binary presence first.
- **Log spam can fill disks within hours.** Always do the post-release health check in Step 6. v0.2.62 shipped with River-saturation log spam that filled gateways at ~10 GB/day (#4251); v0.2.63's release wave addresses both root-cause (#4253) and symptom (#4252).
- **Streaming default broke riverctl** (v0.2.11). Always run the Step 5 River smoke test before considering the release fully shipped.
- **PR title must use `build:` prefix**, not `chore:` — the commit-msg hook only allows feat/fix/docs/style/refactor/perf/test/build/ci.
- **PATH shadowing.** Old `cargo install freenet` may leave a stale binary at `~/.cargo/bin/freenet` shadowing `/usr/local/bin/freenet`; always use absolute paths when verifying running versions.
- **Binary on disk ≠ running process.** Verify via `systemctl show -p MainPID` + `/proc/PID/exe`, not just the file on disk.
- **Release `merge_group` runs the full suite as the pre-publish gate** (#3973). Don't try to skip it.

## Success Criteria

Release is complete when:

- ✓ `release.yml` workflow succeeded
- ✓ crates.io shows the new version for both `freenet` and `fdev`
- ✓ GitHub release tagged with all required binaries attached
- ✓ `gateway-update.yml` and `release-announce.yml` cascade runs succeeded
- ✓ River smoke test passes
- ✓ Gateways running the new version, logs clean
- ✓ Network telemetry healthy
