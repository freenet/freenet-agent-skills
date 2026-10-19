---
name: release
description: Orchestrate a new freenet-core release. Runs the MANDATORY pre-cut gates (no concurrent cut, auto-update updater diff + canary suites, a 30-minute real-NAT soak of the exact ship SHA, a telemetry baseline), then determines the version, confirms with the user, triggers the release pipeline via GitHub Actions, and monitors telemetry through the 0-4h auto-update stagger. Use when the user says "do a release", "new release", "cut a release", "release", or "/release".
user_invocable: true
license: LGPL-3.0
---

# Freenet Release Skill

This is the **single entry point** for cutting a freenet-core release. The order is fixed:

1. **MANDATORY PRECONDITIONS** P0-P4 (below). Every one must pass, and you must report each result.
2. Steps 1-5: version, trigger, watch (including the ship-vs-soak check **before** the tag is pushed), verify artifacts, River smoke test.
3. **Step 6: post-cut telemetry monitoring** through the 0-4h auto-update stagger.

**Do not dispatch `release.yml` or run `scripts/release.sh` until P0-P4 have passed.** No "quick release", "routine patch" or "CI is green" path skips them. The only thing you may run beforehand is `scripts/release.sh --dry-run`.

**A `dry_run=true` dispatch of `release.yml` is NOT side-effect free.** Its version-bump job has no dry-run guard, so it pushes a release branch, opens a real `build: release X.Y.Z` PR and auto-merges it into `main`. That makes it a trigger: it needs the preconditions too, and it moves `main` past the SHA you soaked.

The release pipeline runs entirely in GitHub Actions: version-bump PR, merge-queue CI gate, `cargo publish --dry-run`, tag and draft GitHub release, cross-compiled binaries, Gate A, crates.io publish, then un-draft. The `release.published` event then auto-triggers `gateway-update.yml` (which HMAC-POSTs each gateway's release-agent) and `release-announce.yml` (Matrix and River posts). CI does **not** exercise a real NATed peer, and it does not exercise the shipping binary's own updater. That is why the preconditions exist.

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
gh run list --workflow cross-compile.yml --repo freenet/freenet-core --limit 5 \
    --json databaseId,status,headBranch,event,createdAt   # the previous tag's publish/un-draft
gh pr list --repo freenet/freenet-core --state open --search 'build: release in:title'
```

**Stop** in any of these cases:

- a `release.yml` run is `queued` or `in_progress`
- a tag's `cross-compile.yml` run is still running (that is where the previous release publishes and un-drafts)
- a `build: release` PR is open
- another maintainer is mid-soak or mid-cut (ask in the dev channel if unsure)

Coordinate first. **Re-run these checks immediately before Step 2**: the soak takes 30+ minutes, and the state can change during it.

### P1: Auto-update is not broken (updater diff + BOTH canary suites)

Auto-update is the highest-consequence subsystem in a release because a peer's update path has only one leg. Every stage of it is the binary being replaced. A broken updater therefore **cannot be recovered in the field**: the affected cohort never self-heals and has to be fixed by hand. v0.2.120/v0.2.121 (#5221) did exactly this. It was broken fleet-wide, went unnoticed for two releases, and about 1,100 nodes were updated manually. Answer "is auto-update safe?" with commands, not from memory, and not from the fact that CI is green.

**Step 1: does the payload touch the updater?**

```bash
R=<your freenet-core checkout>
git -C "$R" fetch -q origin
LAST_TAG=$(git -C "$R" describe --tags --abbrev=0 origin/main)
git -C "$R" diff --stat "$LAST_TAG"..origin/main -- \
  crates/core/src/bin/commands/auto_update.rs \
  crates/core/src/bin/commands/update.rs crates/core/src/bin/commands/update/ \
  crates/core/src/bin/freenet.rs \
  crates/core/src/bin/commands/service.rs crates/core/src/bin/commands/service/ \
  crates/core/src/bin/commands/rollback.rs \
  scripts/auto-update-canary.sh scripts/auto-update-canary_test.sh \
  scripts/auto-update-canary_lifecycle_test.sh scripts/release_canary_wiring_test.sh \
  .github/workflows/cross-compile.yml .github/workflows/release.yml
```

If any file changed, read the full diff. A diff that is entirely comments is not a behaviour change, but **prove** that rather than eyeballing it. For a shell script, strip whole-line comments only. Stripping everything after a `#` would also delete executable `${x##*/}` and `${1#v}` expansions, and could falsely report "identical".

```bash
f=scripts/auto-update-canary.sh
diff <(git -C "$R" show "$LAST_TAG:$f" | sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d') \
     <(git -C "$R" show "origin/main:$f" | sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d') \
  && echo "IDENTICAL apart from whole-line comments"
```

**Step 2: run BOTH canary self-test suites.** They are fast and hermetic, and need no node. A failure blocks the cut.

```bash
cd "$R"
bash scripts/auto-update-canary_test.sh            # wiring pins: markers, trigger sites, frozen constants
bash scripts/auto-update-canary_lifecycle_test.sh  # Gate B retries INDETERMINATE, never a real failure
```

**Step 3: know what CI's gates do not cover.** Gate A (pre-flight, which blocks the crates.io publish) and Gate B (self-update canary from the previous release to this one, post-publish and non-blocking) run automatically in the **`cross-compile.yml` run for the release tag**, not in `release.yml`. They have two structural gaps that no green tick reveals:

- **Gate B runs the PREVIOUS release's updater.** The shipping binary's own installer half (checksum, signature, extract, swap, restart) is never exercised in its own release.
- **The canary is Linux musl x86_64 only.** macOS has partial cover through the dmg-swap E2E. **Windows has no auto-update gate at all** (#5341).

The P2 soak peer runs with auto-update **enabled**. It is the only real-NAT observer of the released updater, so never disable auto-update on it. If you need to freeze its version, stop the service instead.

### P2: Real-NAT pre-release soak of the exact ship SHA (30 minutes)

Unit, simulation and CI tests miss regressions that only real subscription and UPDATE traffic over a NAT link surface. Examples are the #4345 GET-stream-assembly failures, connection-teardown bugs and log spam. All of the following are required:

- **Exact ship SHA.** Build the SHA the bump PR will sit on top of: the current `origin/main` HEAD. The release is tagged on the bump PR's merge commit, so the version bump should be the only thing separating the tag from what you soaked. If `main` moves before you trigger, the soak no longer covers what ships, so re-soak the new SHA. Step 3 checks this again the moment the bump PR merges.
- **Merge freeze from soak start until the bump PR merges.** Nothing may merge to freenet-core `main` in that window, including PRs queued ahead of the bump PR in the merge queue. Any such merge moves `main` off the soaked SHA, so the release would ship code the soak never ran, and a soak-gate hook will refuse the cut. Ask the user to declare a merge freeze before you start the soak. Do not enqueue or auto-merge your own PRs in that window, and disable auto-merge on any that are pending (`gh pr merge <N> --repo freenet/freenet-core --disable-auto`). If anything merges in the window anyway, re-soak the new `origin/main` HEAD.
- **Clean, non-dirty build.** `git status --short` must be empty, **including untracked files**. `build.rs` stamps the build from `git status --porcelain`, and **a `-dirty` build has auto-update DISABLED**, so a soak of a dirty binary proves nothing about the updater (freenet-core#5613). Check the **artifact**: `freenet --version` on the soak peer must show the ship SHA with no `-dirty` suffix.
- **A real NATed peer, upgraded to that binary.** It must not be a gateway, a loopback simulation or a datacenter host with a public IP. Auto-update must stay enabled on it (see P1).
- **River room check.** On the soak peer's own node, the Freenet Official room must load: members render, the composer is present, it is not stuck on "Subscribing…", and there is no WASM panic. River renders inside an **iframe**, so assertions against the top-level document see an empty page and report a healthy room as dead. Select the content frame.
- **Subscribe/UPDATE test message.** Send one innocuous message to the Freenet Official room as owner (maintainers: the local `river-official-room` skill; otherwise ask the room owner). Confirm it appears in the soak peer's UI. This proves the new binary applies a contract UPDATE over its live subscription.
- **A 30-minute log and behaviour watch on the new binary.** This is the standard duration. Shorter does not count. Watch for panics or service restarts, the #4345 stream-assembly signature, connection failures and timeouts, and log spam (one message repeating hundreds of times). Save the log excerpt; it becomes the pre-release baseline that Step 6 compares gateways against.

**If no real-NAT peer is available**, the default is to **wait**. A weaker fallback exists for one narrow case only, and it needs the user's **explicit approval**:

- **Eligibility:** config, telemetry or CI-only releases, with no transport, subscribe, UPDATE or contract-runtime change. Show the user the changed files and why each one qualifies.
- **The fallback:**
  - the full simulation suite green
  - a 30-minute smoke test of the ship binary on a **non-service test instance** next to a gateway (never overwrite a gateway's service binary), exercising River
  - heightened Step 6 monitoring
  - the real-NAT gap stated in the release report
- **Anything touching those runtime paths:** do not ship without real-NAT validation. Wait for a NATed peer, or stand one up: a real NATed host, such as a cloud VM behind a NAT gateway. A loopback, netns or container "NAT" simulation does not count.

**Gate:** if anything regressed, **do not release**. Roll the soak peer back to its previous binary and investigate.

### P3: Pre-cut telemetry baseline

Step 6 is only meaningful against a baseline taken **before** the cut. Using the dashboard at telemetry.freenet.org (or the maintainer-local `freenet-telemetry-monitor` skill), record and save the following:

- GET, PUT, SUBSCRIBE and UPDATE success rates and latency
- peer and connection counts
- the current version distribution
- gateway error rates and log growth (about 1 MB/h is normal)

Note the time window you measured. Save it somewhere you can diff against later, not just in chat.

### P4: Report the gates and confirm

Before Step 2, tell the user which gates ran and what each returned: P0-P3, plus the soak SHA, `--version` output, soak duration and room/message result. "CI is green" is not an answer to "did we break auto-update". The canary suites and the soak answer that, and they are different signals. Then confirm the version and changelog (Step 1).

## Arguments

- If an argument is provided (e.g., `/release 0.2.65`), use it as the target version.
- If no argument is provided, work it out from `crates/core/Cargo.toml`: increment its patch. If unreleased PRs have already bumped it past the last tag, **use the current Cargo.toml version as-is** rather than incrementing again. That is the version those PRs were intended for.
- **Always pass the chosen version to the workflow explicitly (`--field version=X.Y.Z`). Never leave `version` blank.** A blank input makes `release.yml` auto-bump the patch of the latest **crates.io** release, which ignores `Cargo.toml` and can differ from the version you confirmed with the user.

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

**Only after P0-P4 have passed for the current `origin/main` SHA.** Run Steps 2 and 3 from the up-to-date freenet-core checkout from Step 1.

```bash
VER=X.Y.Z                                     # the version confirmed in Step 1
SOAKED=<the SHA you soaked in P2>
T0=$(date -u +%FT%TZ)                         # recorded BEFORE the trigger; used to ignore older runs and PRs
gh workflow run release.yml --repo freenet/freenet-core --field version="$VER"
```

Inputs (see `gh workflow view release.yml --yaml`):

- `version`: **always set it explicitly** to the version confirmed in Step 1. Never leave it blank: blank auto-bumps from the latest crates.io release, not from `Cargo.toml` (see Arguments).
- `skip_tests`: skips the pre-release local tests (CI still runs on the PR).
- `dry_run`: skips the tag and the GitHub release, **but still opens and auto-merges the version-bump PR**. Treat it as a real trigger.

Get the id of the run you just started. `gh run list --limit 1` right after the trigger often still returns the previous run, so filter by `T0`:

```bash
RUN_ID=""
until [ -n "$RUN_ID" ]; do
  RUN_ID=$(gh run list --workflow release.yml --repo freenet/freenet-core --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$T0\")][0].databaseId // empty")
  [ -n "$RUN_ID" ] || sleep 10
done
echo "release run: $RUN_ID"
```

## Step 3: Watch the Release Run

`release.yml` runs these jobs in order:

1. `validate`
2. `update_versions` pushes branch `release/v$VER`, opens the `build: release X.Y.Z` PR (about a minute after the trigger) and enables auto-merge.
3. `wait_for_pr` waits roughly 20-75 minutes for the merge queue, then resolves the PR's merge commit as the release SHA.
4. `verify_publishable` runs `cargo publish --dry-run` (about 4-5 minutes).
5. `create_release` pushes the `vX.Y.Z` tag on the release SHA and creates the draft release, seconds after `verify_publishable` finishes.

The whole run takes roughly 30-60 minutes. The tag push starts the tag's `cross-compile.yml` run, which publishes to crates.io and un-drafts the release; that starts the 0-4h auto-update stagger.

### Check that what ships is what you soaked, BEFORE the tag is pushed

Anything that landed on `main` while the bump PR sat in the queue is in the release SHA. Check it **as soon as the bump PR merges**. Between that merge and the tag push there are only the 4-5 minutes of `verify_publishable`, too little to notice a failure and cancel by hand. So start this script in a **backgrounded** call right after you have `RUN_ID`. It cancels the run itself if the check fails:

```bash
# 1. Wait for THIS run's bump PR. Its head branch is always release/v$VER, but older
#    attempts at the same version can share that branch, so ignore PRs created before T0.
PR=""
until [ -n "$PR" ]; do
  PR=$(gh pr list --repo freenet/freenet-core --head "release/v$VER" --state all --json number,createdAt \
      -q "[.[] | select(.createdAt >= \"$T0\")][0].number // empty")
  [ -n "$PR" ] || sleep 15
done
# 2. Wait for it to leave OPEN. Stop if the release run ends first (e.g. wait_for_pr timed out).
while STATE=$(gh pr view "$PR" --repo freenet/freenet-core --json state -q .state); [ "$STATE" = OPEN ]; do
  [ "$(gh run view "$RUN_ID" --repo freenet/freenet-core --json status -q .status)" = completed ] \
    && { echo "release run ended while bump PR #$PR is still OPEN; investigate"; exit 1; }
  sleep 15
done
[ "$STATE" = MERGED ] || { echo "bump PR #$PR is $STATE, not merged; the run will not tag. Investigate"; exit 1; }
# 3. mergeCommit can lag behind MERGED for a few seconds.
MERGE_SHA=""
until [[ "$MERGE_SHA" =~ ^[0-9a-f]{40}$ ]]; do
  MERGE_SHA=$(gh pr view "$PR" --repo freenet/freenet-core --json mergeCommit -q '.mergeCommit.oid // empty')
  [[ "$MERGE_SHA" =~ ^[0-9a-f]{40}$ ]] || sleep 5
done
# 4. The diff must be exactly the version files. Anything else: cancel before the tag.
git fetch -q origin
EXTRA=$(git diff --name-only "$SOAKED" "$MERGE_SHA" | grep -vxE 'Cargo\.lock|crates/core/Cargo\.toml|crates/fdev/Cargo\.toml')
if [ -n "$EXTRA" ]; then
  gh run cancel "$RUN_ID" --repo freenet/freenet-core --force
  echo "SOAK MISMATCH: release SHA $MERGE_SHA differs from soaked $SOAKED in:"; echo "$EXTRA"
  exit 1
fi
echo "OK: $MERGE_SHA differs from $SOAKED only in version files"
```

`--force` matters: `verify_publishable` and `create_release` carry `if: always()`, which a plain cancel does not override. If the script reports a mismatch, or you cancel for any other reason, **keep both safety checks**:

```bash
gh run view "$RUN_ID" --repo freenet/freenet-core --json status,jobs \
    -q '.status, (.jobs[] | "\(.name): \(.status) \(.conclusion)")'    # "Create GitHub release" must not be success
git ls-remote --tags origin "v$VER"                                       # must print nothing
```

Ignore the `Release summary` job's log after a cancel. It is `if: always()` and can still say the release was cut.

If the cancel lost the race and `v$VER` exists, act fast. The tag's `cross-compile.yml` run reaches `attach-to-release` about 25 minutes after the tag push, and that job runs Gate A and then publishes to crates.io. Cancel it first:

```bash
CC_ID=$(gh run list --workflow cross-compile.yml --repo freenet/freenet-core --branch "v$VER" --limit 1 \
    --json databaseId -q '.[0].databaseId')
gh run cancel "$CC_ID" --repo freenet/freenet-core --force
curl -s https://crates.io/api/v1/crates/freenet | jq -r .crate.max_version   # must be the PREVIOUS version, not $VER
```

`--force` also stops the `always()` canary-failure notifier. If it posts anyway, add a note to the dev channel saying the cancel was deliberate and is not an auto-update failure.

**If crates.io already shows `$VER`, the crates are published. Do NOT roll back; stop and escalate to the user.** Otherwise, delete the tag and the draft release. `release-rollback.sh` must run from the root of a freenet-core checkout, because it uses that checkout's git remote. It asks for an interactive `yes`; in a non-interactive shell, pipe it in, or it aborts and deletes nothing:

```bash
cd <your freenet-core checkout>
printf 'yes\n' | ./scripts/release-rollback.sh --version "$VER"   # deletes the tag and the GitHub release; no --yank-crates
git ls-remote --tags origin "v$VER"                               # must now print nothing
```

Either way, the version-bump commit stays on `main` and nothing was published, so tell the user what happened. Any re-cut starts again from P0 with a soak of the new `origin/main` HEAD. Agree the version with the user. Re-using `$VER` is fine, because nothing was published or tagged, but it creates a second `build: release $VER` PR on the same branch name; the `T0` filter above handles that. The alternative is the next patch.

### Watch the tag's cross-compile run

`release.yml` going green is **not** the end. The tag push starts a `cross-compile.yml` run, and that run builds the binaries, runs **Gate A** (which blocks publish), publishes to crates.io, un-drafts the release and runs **Gate B**. Watch that run too, and the release run itself, each with `gh run watch` in a backgrounded call; never poll by hand:

```bash
gh run watch "$RUN_ID" --repo freenet/freenet-core --interval 30 --exit-status
gh run view "$RUN_ID" --repo freenet/freenet-core --log-failed | tail -100   # on failure
gh run list --workflow cross-compile.yml --repo freenet/freenet-core --branch "v$VER" --limit 1 \
    --json databaseId,status,conclusion
gh run watch <that id> --repo freenet/freenet-core --interval 30 --exit-status
```

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

Protocol changes can silently break River clients even when every freenet-core test passes. Examples are new wire variants, streaming defaults and serialization changes.

`ROOM_VK` is the Freenet Official room's **owner verifying key**. Take it from the "Room Owner VK" entry in the maintainer-local `river-official-room` skill; without that skill, ask the room owner. It changes when the room is re-created, so look it up each release and do not hardcode it.

```bash
ROOM_VK=<Room Owner VK from the river-official-room skill>
cd <your river checkout>
cargo run -p riverctl -- member list "$ROOM_VK"
```

A bincode deserialization error means **STOP**: roll back (see "Rollback"), file an issue, and rebuild River against the new stdlib. In v0.2.11, enabling WebSocket streaming by default broke riverctl, which was pinned to stdlib 0.1.40.

## Step 6: Post-cut telemetry monitoring through the 0-4h stagger

Peers adopt a release over a **0-4h decentralised-discovery stagger**, so a regression in the shipped binary keeps spreading for hours after the gateways look fine. Keep monitoring until the stagger has fully elapsed. The release is not done when the workflow goes green.

1. **Gateways (+10-15 min):** each gateway runs the new version, and its logs are clean against the P2 baseline. Maintainers: host access is in the local `freenet-release` and `freenet-gateway-ops` skills. Grep for signatures specific to the subsystems **this** release touched, not just generic errors.
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
# From the root of a freenet-core checkout. Each prompts for "yes"; pipe it in a non-interactive shell.
./scripts/release-rollback.sh --version <VERSION>                # keeps crates.io
./scripts/release-rollback.sh --version <VERSION> --yank-crates  # disruptive; undo with cargo yank --undo
./scripts/release-rollback.sh --version <VERSION> --dry-run
```

## Common Workflow Failures

- **PR title fails Conventional Commits.** The release PR title must be `build: release X.Y.Z`. Patch it with `gh api repos/freenet/freenet-core/pulls/<PR> --method PATCH -f title="build: release X.Y.Z"`.
- **Merge queue is slow on the release PR.** Release `merge_group` entries run the full suite (Unit & Integration, Simulation, NAT Validation) as the pre-publish gate (#3973). Expect 20-30 min. Do not merge by hand to skip it.
- **The cascade didn't fire after `release.published`.** `RELEASE_PAT` is missing or expired. The manual fallback is `gh workflow run gateway-update.yml --field version=X.Y.Z` and `gh workflow run release-announce.yml --field version=X.Y.Z`.
- **Cross-compile attached partial binaries.** Find the failed target with `gh run view <run-id> --log-failed`, then re-run it with `gh run rerun <run-id> --failed`, or with `gh workflow run cross-compile.yml`.
- **Re-announcing by hand.** Check that every required binary is attached first. The automatic cascade waits for `release.published`, which fires only after the binaries exist; a manual re-trigger does not wait.
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
- ✓ the `release.yml` workflow succeeded, AND the tag's `cross-compile.yml` run succeeded, including Gate A and Gate B
- ✓ `git diff <soaked-sha> <bump PR merge commit>` touched only version files, checked **before** the tag was pushed
- ✓ crates.io shows the new version for both `freenet` and `fdev`
- ✓ the GitHub release is tagged, with all required binaries attached
- ✓ the `gateway-update.yml` and `release-announce.yml` cascade runs succeeded
- ✓ the River smoke test passes
- ✓ gateways run the new version and their logs are clean
- ✓ telemetry stayed healthy against the P3 baseline through the full 0-4h stagger
