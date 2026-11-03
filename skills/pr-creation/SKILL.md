---
name: pr-creation
description: Guidelines for creating high-quality Freenet pull requests. This skill should be used when creating PRs for freenet-core, freenet-stdlib, or related repositories. Emphasizes quality over speed, thorough testing, and proper review process.
license: LGPL-3.0
---

# Freenet Pull Request Quality Standards

Our goal is high-quality code that won't need follow-up fixes. A quick fix that causes problems later wastes more time than doing it right the first time.

## Before Creating the PR

### Claim the Issue

If your PR fixes a GitHub issue, **verify the issue is unassigned** before starting work. If someone else is already assigned, check with them or the user before proceeding — don't duplicate effort. If the issue is unassigned, assign it to yourself immediately so others know it's being worked on:

```bash
gh issue edit <ISSUE> --repo freenet/<REPO> --add-assignee @me
```

### Start from current main in a dedicated worktree

Never work in the checkout where `main` lives. Branch from the latest GitHub `main` in a new worktree:

```bash
git fetch origin
git worktree add ../fix-<issue> -b fix-<issue> origin/main
```

### Run Local Checks

```bash
cargo fmt
cargo clippy --all-targets --all-features
cargo test
```

Fix all warnings and errors before pushing.

### Choosing the right test level

Default to simulation tests for routing, topology, subscription and operation behavior: the direct runner (`run_simulation_direct`) is deterministic, fast and runs in CI. Use the Turmoil runner when you need partitions or targeted crashes. Use Docker NAT simulation only for transport behavior that needs real network namespaces (hole-punching, iptables). Use real multi-machine testing only for things that need real latency or architectures. The decision tree is in `.claude/rules/testing.md`.

## PR Title and Description

PR titles must pass the Conventional Commits check in `ci.yml` (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, `ci:`, `perf:`, `style:`, `revert:`); the subject must not start with an uppercase letter.

**Explain WHY, not just WHAT.** Structure the description:

```markdown
## Problem
[What's broken? What's the user impact? Why does it matter?]

## Approach
[Why this solution over alternatives? What's the key insight?]

## Testing
[New tests added and what scenarios they validate]
[Local validation steps performed]
[E2E testing results if applicable]

## Fixes
Closes #XXXX
```

**Bad:** "Add observed_addr field to ConnectRequest"
**Good:** "The joiner can't know its public address until observed externally. Previous approach rewrote addresses at transport boundary, but that's a hack. This lets the gateway fill in the observed socket naturally since it already sees the real UDP source."

## Test Quality Standards

Every PR that changes behavior includes tests that would have caught the problem before merge, covering the bug class and not just the one symptom. Write the test first and confirm it fails without your fix and passes with it.

When fixing a bug, ask "why didn't CI catch this?", name the test layer that should have (unit, integration, simulation, E2E), say so in the PR description, and add that test in the same PR, not in a follow-up issue.

A logic error (wrong threshold, missing data path, bad fallback) is reproducible in a unit or simulation test. Reserve production telemetry for environment-specific problems (real NAT traversal, OOM under load).

For PRs that touch routing, topology, operations or subscription handling, include simulation tests that assert the health metrics the change could regress: subscribe and GET success rates, subscription-tree formation, time to first successful operation. Regressions found later through telemetry mean CI failed.

Make tests as general as the bug class allows. If a pattern caused one bug, search for the same pattern elsewhere and fix it or file issues.

## Review Process

Before reviews, run the `freenet:code-simplifier` agent on the finished PR and commit what it changes, so reviewers see the cleanest version.

Once the PR is complete and CI is green, run `/freenet:pr-review <PR>`. It owns the reviewer set, the external-model pass and the fallback when Codex is unavailable (substitute Claude lenses, record it, never wait).

### Handling Review Feedback

**Take all feedback seriously.** Freenet is complex code and we need to be perfectionists. Don't cherrypick easy wins and ignore harder issues. For each point raised:
- Fix it, OR
- Explain specifically why it's not applicable (with real justification, not convenience)

**The bar for ignoring feedback is HIGH.** Only dismiss a suggestion if it would dramatically increase complexity (like doubling the size of an already large PR). If a suggestion would improve the PR and can reasonably be done, do it.

Use common sense — if a reviewer suggests building a massive test framework for a small change, that's obviously overkill. But don't dismiss feedback just because it's inconvenient or would require more work.

**Never ignore tests to make them pass.** Flaky tests are broken tests: fix the root cause. Never remove existing tests to get green; removing tests that catch bugs is how regressions happen.

### Responding to reviews

Reply on each inline comment with the fix commit or your reasoning. Re-run `/freenet:pr-review` on the new HEAD when the fixes were significant (thresholds in that skill).

### Addressing Claude Rule Review findings

The `Claude PR Rule Review` workflow checks the PR against `.claude/rules/` and posts a sticky comment. Findings at WARNING level set the `rule-review/warnings` status to failure, which blocks merge. Fix them (extract magic numbers to named constants, derive errors with `thiserror`, update stale doc comments, add tests for new paths). Only a maintainer can override with the `review-override` label. Critical patterns (banned APIs such as `Instant::now()`) are enforced separately by the Rule Lint CI job.

## PR Scope

### Keep PRs Focused

- One logical change per PR
- If a fix reveals other issues, file separate issues rather than scope-creeping
- If the PR grows too large, consider splitting it (but avoid complex stacked PRs)

### Wiring Completeness

When a PR adds or modifies enum dispatch (operation types, outcome handling, event routing), the test must exhaustively verify all variants produce the expected result. Common gaps: `outcome()` returning `Irrelevant` for some operation types, match arms with `_ => {}` catch-alls that silently discard new variants, commented-out enum arms.

### Resource Invariant Assertions

For any PR that touches data structures which accumulate entries (HashMaps, Vecs, channels, caches), include assertions that sizes stay bounded after sustained operation. Every insert path must have a corresponding cleanup path that runs on both success and failure/timeout. If the cleanup path isn't obvious, document it in a code comment.

### Don't Cut Corners

- Don't weaken tests to make them pass.
- Don't add `#[ignore]` to get CI green. If a test is genuinely broken and the fix is out of scope, `#[ignore]` it with a reason comment and a tracking issue (`git-workflow.md`); that is the last resort, not the default.
- Don't leave `TODO` comments for things you could fix now.

## Attribution

End all GitHub content (PR descriptions, comments, issues) with:

```
[AI-assisted - Claude]
```

## Bug-prevention rules

freenet-core keeps path-scoped rules in `.claude/rules/`. Before pushing code that touches a `biased;` select, `GlobalExecutor::spawn`, connection removal or cleanup, retry and backoff loops, or deployment config, read the matching section of `code-style.md`, `ring.md`, `transport.md`, `channel-safety.md` or `deployment.md`, and scan `bug-prevention-patterns.md` for the code you touch.

## Checklist Before Merging

- [ ] Title passes the Conventional Commits check; description explains WHY
- [ ] fmt, clippy and tests pass locally; CI is green on the current HEAD
- [ ] Regression test fails without the fix; the CI gap is closed in this PR
- [ ] Simulation health metrics asserted if routing/topology/operations/subscriptions changed
- [ ] Relevant `.claude/rules/` sections read
- [ ] `/freenet:pr-review` run on the current HEAD; every finding fixed or answered
- [ ] Human review comments answered
