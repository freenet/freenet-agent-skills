---
name: release
description: Orchestrate a new freenet-core release. Runs the MANDATORY pre-cut gates (no concurrent cut, auto-update updater diff + canary suites, a 30-minute real-NAT soak of the exact ship SHA, a telemetry baseline), then determines the version, confirms with the user, triggers the release pipeline via GitHub Actions, and monitors telemetry through the 0-4h auto-update stagger. Use when the user says "do a release", "new release", "cut a release", "release", or "/release".
user_invocable: true
license: LGPL-3.0
---

# Freenet Release Skill

This is the **single entry point** for cutting a freenet-core release. The order is fixed:

1. **MANDATORY PRECONDITIONS** P0-P4 (below). Every one must pass, and you must report each result.
2. Steps 1-5: version, trigger, watch, verify artifacts, River smoke test.
3. **Step 6 (precondition P5): post-cut telemetry monitoring** through the 0-4h auto-update stagger.

**Do not trigger `release.yml` or run `scripts/release.sh` until P0-P4 have passed.** No "quick release", "routine patch" or "CI is green" path skips them. The only thing you may run beforehand is a `dry_run=true` dispatch or `release.sh --dry-run`.

The release pipeline runs entirely in GitHub Actions: version bump, then release PR, CI gate, crates.io publish, GitHub release, and cross-compiled binaries. The `release.published` event then auto-triggers `gateway-update.yml` (which HMAC-POSTs each gateway's release-agent) and `release-announce.yml` (Matrix and River posts). CI does **not** exercise a real NATed peer, and it does not exercise the shipping binary's own updater. That is why the preconditions exist.

## MANDATORY PRECONDITIONS: run all of these before ANY trigger

> **Maintainers:** the environment-specific parts of these gates live in your local
> `freenet-release` skill, and **you must run it**. That covers which real-NAT peer you
> soak on, how to reach it and deploy the binary there, gateway hosts, and the traps
> specific to your setup. This skill defines **what** must pass; the local skill says
> **how** in your environment. If you have no local companion, you still have to meet
> every gate by equivalent means. Write down what you did; do not skip a gate.
> Some maintainer environments enforce this with a hook that refuses the trigger unless
> the local soak procedure has recorded a passing result for the current `origin/main` SHA.

### P0: No concurrent cut

Two cuts racing each other produce conflicting release PRs and version bumps. Check:

```bash
gh run list --workflow release.yml --repo freenet/freenet-core --limit 5 \
    --json databaseId,status,conclusion,createdAt,displayTitle
gh pr list --repo freenet/freenet-core --state open --search 'build: release in:title'
```

**Stop** in any of these cases:

- a run is `queued` or `in_progress`
- a `build: release` PR is open
- someone else is mid-soak for a different SHA

Coordinate first.

### P1: Auto-update is not broken (updater diff + BOTH canary suites)

Auto-update is the highest-consequence subsystem in a release because a peer's update path has only one leg. Every stage of it is the binary being replaced. A broken updater therefore **cannot be recovered in the field**: the affected cohort never self-heals and has to be fixed by hand. v0.2.120/v0.2.121 (#5221) did exactly this. It was broken fleet-wide, went unnoticed for two releases, and about 1,100 nodes were updated manually. Answer "is auto-update safe?" with commands, not from memory, and not from the fact that CI is green.

**Step 1: does the payload touch the updater?**

```bash
R=<your freenet-core checkout>
git -C $R fetch -q origin
LAST_TAG=$(git -C $R describe --tags --abbrev=0 origin/main)
git -C $R diff --stat "$LAST_TAG"..origin/main -- \
  crates/core/src/bin/commands/auto_update.rs \
  crates/core/src/bin/commands/update.rs \
  crates/core/src/bin/freenet.rs \
  crates/core/src/bin/commands/service.rs \
  scripts/auto-update-canary.sh scripts/auto-update-canary_test.sh \
  scripts/auto-update-canary_lifecycle_test.sh \
  .github/workflows/cross-compile.yml .github/workflows/release.yml
```

If any file changed, read the change. A diff that is entirely comments is not a behaviour change, but **prove** that rather than eyeballing it. For example:

```bash
f=scripts/auto-update-canary.sh
diff <(git -C $R show "$LAST_TAG:$f" | sed 's/#.*$//;/^[[:space:]]*$/d') \
     <(git -C $R show "origin/main:$f" | sed 's/#.*$//;/^[[:space:]]*$/d') \
  && echo "IDENTICAL - no executable line changed"
```

**Step 2: run BOTH canary self-test suites.** They are fast and hermetic, and need no node. A failure blocks the cut.

```bash
cd $R
bash scripts/auto-update-canary_test.sh            # wiring pins: markers, trigger sites, frozen constants
bash scripts/auto-update-canary_lifecycle_test.sh  # Gate B retries INDETERMINATE, never a real failure
```

**Step 3: know what CI's gates do not cover.** During the release, Gate A (pre-flight) and Gate B (self-update canary, previous release to this one) run automatically. They have two structural gaps that no green tick reveals:

- **Gate B runs the PREVIOUS release's updater.** The shipping binary's own installer half (checksum, signature, extract, swap, restart) is never exercised in its own release.
- **The canary is Linux musl x86_64 only.** macOS has partial cover through the dmg-swap E2E. **Windows has no auto-update gate at all** (#5341).

The P2 soak peer runs with auto-update **enabled**. It is the only real-NAT observer of the released updater, so never disable auto-update on it. If you need to freeze its version, stop the service instead.

### P2: Real-NAT pre-release soak of the exact ship SHA (30 minutes)

Unit, simulation and CI tests miss regressions that only real subscription and UPDATE traffic over a NAT link surface. Examples are the #4345 GET-stream-assembly failures, connection-teardown bugs and log spam. All of the following are required:

- **Exact ship SHA.** Build the `origin/main` HEAD that the release will tag. If `main` moves before you trigger, the soak no longer covers what ships, so re-soak the new SHA.
- **Clean, non-dirty build.** `git status --short` must be empty, **including untracked files**. `build.rs` stamps the build from `git status --porcelain`, and **a `-dirty` build has auto-update DISABLED**, so a soak of a dirty binary proves nothing about the updater (freenet-core#5613). Check the **artifact**: `freenet --version` on the soak peer must show the ship SHA with no `-dirty` suffix.
- **A real NATed peer, upgraded to that binary.** It must not be a gateway, a loopback simulation or a datacenter host with a public IP. Auto-update must stay enabled on it (see P1).
- **River room check.** On the soak peer's own node, the Freenet Official room must load: members render, the composer is present, it is not stuck on "Subscribing…", and there is no WASM panic. River renders inside an **iframe**, so assertions against the top-level document see an empty page and report a healthy room as dead. Select the content frame.
- **Subscribe/UPDATE test message.** Send one innocuous message to the Freenet Official room as owner (see the `river-official-room` skill, or ask the room owner). Confirm it appears in the soak peer's UI. This proves the new binary applies a contract UPDATE over its live subscription.
- **A 30-minute log and behaviour watch on the new binary.** This is the standard duration. Shorter does not count. Watch for panics or service restarts, the #4345 stream-assembly signature, connection failures and timeouts, and log spam (one message repeating hundreds of times). Save the log excerpt; it becomes the pre-release baseline that Step 6 compares gateways against.

**If no real-NAT peer is available**, fall back by risk tier:

- **Config, telemetry or CI-only releases** with no transport, subscribe, UPDATE or contract-runtime change MAY ship on a weaker fallback, provided the real-NAT gap is stated in the release report. The fallback is: the full simulation suite green, a 30-minute smoke test of the ship binary on a **non-service test instance** next to a gateway (never overwrite a gateway's service binary) that exercises River, and heightened Step 6 monitoring.
- **Anything touching those runtime paths:** do not ship without real-NAT validation. Wait for a NATed peer, or stand one up (a cloud VM behind NAT, or a netns/container peer).

**Gate:** if anything regressed, **do not release**. Roll the soak peer back to its previous binary and investigate.

### P3: Pre-cut telemetry baseline

Step 6 is only meaningful against a baseline taken **before** the cut. Using the `freenet-telemetry-monitor` skill (or the dashboard at telemetry.freenet.org), record and save the following:

- GET, PUT, SUBSCRIBE and UPDATE success rates and latency
- peer and connection counts
- the current version distribution
- gateway error rates and log growth (about 1 MB/h is normal)

Note the time window you measured. Save it somewhere you can diff against later, not just in chat.

### P4: Report the gates and confirm

Before Step 2, tell the user which gates ran and what each returned: P0-P3, plus the soak SHA, `--version` output, soak duration and room/message result. "CI is green" is not an answer to "did we break auto-update". The canary suites and the soak answer that, and they are different signals. Then confirm the version and changelog (Step 1).

## Arguments

- If an argument is provided (e.g., `/release 0.2.65`), use it as the target version.
- If no argument is provided, auto-detect: increment the patch of the version currently in `crates/core/Cargo.toml`. If unreleased PRs have already bumped it past the last tag, **use the current Cargo.toml version as-is** rather than incrementing again. That is the version those PRs were intended for.

## Step 1: Determine Version and Show Changelog

```bash
cd <your freenet-core checkout>
git pull origin main                                           # MUST pull first
LAST_TAG=$(git describe --tags --abbrev=0)
CARGO_VERSION=$(grep "^version" crates/core/Cargo.toml | cut -d'"' -f2)
echo "Last release tag: $LAST_TAG"
echo "Cargo.toml says:  $CARGO_VERSION"
git log --oneline "$LAST_TAG"..HEAD
git rev-parse HEAD                                             # must equal the SHA you soaked in P2
```

Pick the target version (see Arguments above). Present the user with the current version, target version and a categorised changelog. **Confirm before triggering.**

## Step 2: Trigger the Release Workflow

**Only after P0-P4 have passed for the current `origin/main` SHA.**

```bash
gh workflow run release.yml --repo freenet/freenet-core --field version=X.Y.Z
```

Inputs (see `gh workflow view release.yml --yaml`):

- `version`: leave blank to auto-patch-bump from the latest crates.io release.
- `skip_tests`: skips the pre-release local tests (CI still runs on the PR).
- `dry_run`: shows what would happen without publishing. This is the only dispatch allowed before the preconditions pass.

Confirm the run started:

```bash
gh run list --workflow release.yml --repo freenet/freenet-core --limit 1 \
    --json databaseId,status,event,createdAt
```

## Step 3: Watch the Release Run

The workflow takes about 20-30 minutes. Use `gh run watch` in a backgrounded call so you are notified on completion; never poll by hand.

```bash
RUN_ID=$(gh run list --workflow release.yml --repo freenet/freenet-core --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --repo freenet/freenet-core --interval 30 --exit-status
gh run view "$RUN_ID" --repo freenet/freenet-core --log-failed | tail -100   # on failure
```

Watch Gate A and Gate B (P1) in this run. They are the end-to-end updater test.

## Step 4: Verify the Release Artifacts

```bash
VER=X.Y.Z
cargo search freenet --limit 1                                  # new version
cargo search fdev --limit 1                                     # bumped fdev
gh release view "v$VER" --repo freenet/freenet-core --json assets --jq '.assets[].name'
gh run list --workflow gateway-update.yml --repo freenet/freenet-core --limit 1
gh run list --workflow release-announce.yml --repo freenet/freenet-core --limit 1
```

**Required binaries:**

- `freenet-x86_64-unknown-linux-musl.tar.gz`
- `freenet-aarch64-unknown-linux-musl.tar.gz`
- `freenet-x86_64-apple-darwin.tar.gz`
- `freenet-aarch64-apple-darwin.tar.gz`
- `freenet-x86_64-pc-windows-msvc.zip`
- `freenet.exe`
- the corresponding `fdev-*` archives
- `SHA256SUMS.txt`

Both cascade runs should show recent runs started after the release. If either is missing, `RELEASE_PAT` may have expired (see freenet-core's AGENTS.md).

## Step 5: River Compatibility Smoke Test

Protocol changes can silently break River clients even when every freenet-core test passes. Examples are new wire variants, streaming defaults and serialization changes. Get the current Freenet Official room owner VK from the `river-official-room` skill; it rotates, so do not hardcode it.

```bash
cd <your river checkout>
cargo run -p riverctl -- member list "$ROOM_VK"
```

A bincode deserialization error means **STOP**: roll back (see "Rollback"), file an issue, and rebuild River against the new stdlib. In v0.2.11, enabling WebSocket streaming by default broke riverctl, which was pinned to stdlib 0.1.40.

## Step 6 (precondition P5): Post-cut telemetry monitoring through the 0-4h stagger

Peers adopt a release over a **0-4h decentralised-discovery stagger**, so a regression in the shipped binary keeps spreading for hours after the gateways look fine. Keep monitoring until the stagger has fully elapsed. The release is not done when the workflow goes green.

1. **Gateways (+10-15 min):** each gateway runs the new version, and its logs are clean against the P2 baseline. Use your local `freenet-release` skill and `freenet-gateway-ops` for host access. Grep for signatures specific to the subsystems **this** release touched, not just generic errors.
2. **Telemetry at roughly +30 min, +1 h, +2 h and +4 h**, compared with the P3 baseline:
   - version adoption is climbing
   - GET/SUBSCRIBE/UPDATE success rates and latency hold
   - connection counts hold
   - no new error classes appear
   - log growth is normal
3. **Roll back immediately** on crashes, log spam, data loss or a clear success-rate regression. Open an issue with the evidence, and post a rollback notice on Matrix.

Watch for log spam (it can fill disks within hours), new error patterns, connection failures (`connection refused`, `timeout`, `handshake failed`) and resource exhaustion (`out of memory`, `no space left`, `too many open files`).

## Rollback

```bash
./scripts/release-rollback.sh --version <VERSION>                # keeps crates.io
./scripts/release-rollback.sh --version <VERSION> --yank-crates  # irreversible
./scripts/release-rollback.sh --version <VERSION> --dry-run
```

## Common Workflow Failures

- **PR title fails Conventional Commits.** The release PR title must be `build: release X.Y.Z`. Patch it with `gh api repos/freenet/freenet-core/pulls/<PR> --method PATCH -f title="build: release X.Y.Z"`.
- **Merge queue is slow on the release PR.** Release `merge_group` entries run the full suite (Unit & Integration, Simulation, NAT Validation) as the pre-publish gate (#3973). Expect 20-30 min. Do not merge by hand to skip it.
- **The cascade didn't fire after `release.published`.** `RELEASE_PAT` is missing or expired. The manual fallback is `gh workflow run gateway-update.yml --field version=X.Y.Z` and `gh workflow run release-announce.yml --field version=X.Y.Z`.
- **Cross-compile attached partial binaries.** Find the failed target with `gh run view <run-id> --log-failed`, then re-run that platform.
- **A draft release has NO Windows assets.** Windows Authenticode signing is fail-closed by design. The `Verify signatures` step throws before upload, so an empty Windows slot is the expected shape of a signing failure. Read that step's output first. **Never strip the signing steps** to force a release through.

## Version Scheme

- **freenet:** `0.2.X`, with the patch incremented each release.
- **fdev:** `0.3.X`, with the patch auto-incremented by the workflow (independent versioning).

## Incident Learnings

- **Releasing without the real-NAT soak.** The soak and auto-update gates once lived only in one maintainer's local skill, so a session using this skill nearly cut a release without them. That is why they are MANDATORY PRECONDITIONS here.
- **A broken updater is unrecoverable in the field.** v0.2.120/v0.2.121 (#5221): about 1,100 nodes were updated by hand. The soak peer's auto-update had been disabled for a measurement and was never re-enabled.
- **A `-dirty` soak binary has auto-update off** (#5613), so the soak passes while proving nothing. Check `--version` on the artifact.
- **Don't run release steps by hand** (`cargo publish`, `gh release create`, `gh release edit`). Doing so caused a user-facing 404 during v0.1.177.
- **Log spam can fill disks within hours.** v0.2.62 hit about 10 GB/day on gateways (#4251).
- **The streaming default broke riverctl** (v0.2.11). Always run the Step 5 smoke test.
- **PATH shadowing.** A stale `~/.cargo/bin/freenet` can shadow the installed binary, so use absolute paths when verifying versions.
- **A binary on disk is not the running process.** Verify with `/proc/<MainPID>/exe`.

## Success Criteria

The release is complete when all of these hold:

- ✓ P0-P4 passed and were reported **before** the trigger, and the soak covered the exact ship SHA for 30 minutes
- ✓ the `release.yml` workflow succeeded, including Gate A and Gate B
- ✓ crates.io shows the new version for both `freenet` and `fdev`
- ✓ the GitHub release is tagged, with all required binaries attached
- ✓ the `gateway-update.yml` and `release-announce.yml` cascade runs succeeded
- ✓ the River smoke test passes
- ✓ gateways run the new version and their logs are clean
- ✓ telemetry stayed healthy against the P3 baseline through the full 0-4h stagger
