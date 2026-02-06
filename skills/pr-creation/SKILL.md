---
name: pr-creation
description: Guidelines for creating high-quality Freenet pull requests. This skill should be used when creating PRs for freenet-core, freenet-stdlib, or related repositories. Emphasizes quality over speed, thorough testing, and proper review process.
license: LGPL-3.0
---

# Freenet Pull Request Quality Standards

## Core Philosophy

**Our goal is high-quality code that won't require future fixes.** Don't cut corners, be a perfectionist, don't increase tech debt. A quick fix that causes problems later wastes more time than doing it right the first time.

## Before Creating the PR

### Sync with Latest Main from GitHub

**CRITICAL:** Always ensure you're working from the latest `main` branch from GitHub, not a stale local copy:

```bash
cd ~/code/freenet/freenet-core/main
git fetch origin
git log --oneline -1 origin/main  # Check what's latest on GitHub
git pull origin main              # Update local main
git log --oneline -1              # Verify you have the latest
```

This prevents:
- Working on outdated code that's already been fixed
- Merge conflicts when the PR is ready
- Basing work on code that's already been superseded

### Create a Worktree

Never work directly in the main worktree. Create a dedicated worktree for your branch:

```bash
cd ~/code/freenet/freenet-core/main
git worktree add ../fix-<issue-number> -b fix-<issue-number>
cd ../fix-<issue-number>
```

### Verify Your Environment

```bash
# CRITICAL: Verify you're in a worktree, not the main directory
pwd  # Should be .../freenet-core/<branch-name>, NOT .../freenet-core/main
git branch --show-current  # Should be your feature branch
```

### Run Local Checks

```bash
cargo fmt
cargo clippy --all-targets --all-features
cargo test
```

Fix all warnings and errors before pushing.

### E2E Testing

For changes affecting network behavior, contract operations, or peer communication:
- Use **freenet-simulated-network-test** for automated Docker-based testing (6-peer CI infrastructure)
- Use **freenet-manual-multipeer-test** for real machine testing across nova/vega/technic

## PR Title and Description

### Title Format

PR titles **must** follow Conventional Commits - CI fails non-conforming titles:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `refactor:` - Code change that neither fixes a bug nor adds a feature
- `test:` - Adding or correcting tests
- `chore:` - Maintenance tasks

### Description Requirements

**Explain WHY, not just WHAT.** Structure your PR description:

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

### A Bug That Made It Past CI Is Also a Bug in CI

When fixing a bug, always ask: **"Why didn't CI catch this?"**

Investigate which test layer should have caught it:
- Unit tests for logic errors
- Integration tests for component interactions
- Network simulations for distributed behavior
- E2E tests for real-world scenarios

Document the gap in your PR description.

### Regression Tests Must Reproduce the Bug

1. Write the test **before** the fix
2. Verify the test **fails** without your fix
3. Verify the test **passes** with your fix

This ensures the test actually catches the bug, not just the happy path.

### Make Tests General

When improving tests, make the new test as general as possible while still catching the specific problem found. A test that catches a class of bugs is better than one that only catches the exact scenario you hit.

### Search for Similar Bugs

If a pattern caused a bug, search for similar patterns elsewhere in the codebase. Fix them all, or file separate issues for each.

## Review Process

### Code Simplification (Before Reviews)

**Before running review agents**, use the `code-simplifier` agent to clean up, simplify code, and verify documentation:

```
Task tool with subagent_type="general-purpose", prompt includes agents/code-simplifier.md instructions:

"Simplify PR #<NUMBER> (branch-name) at /path/to/worktree

Modified files:
- [list modified files]"
```

**Commit any simplifications before running reviews** — reviewers should see the cleanest version of the code.

### Run the PR Review Skill

Once the PR is complete, code is simplified, and CI is passing, run the `pr-review` skill which handles all four parallel review agents:

```
/freenet:pr-review <PR-NUMBER>
```

See the `pr-review` skill for the full review process (code-first, testing, skeptical, big-picture).

### Handling Review Feedback

**Take all feedback seriously.** Freenet is complex code and we need to be perfectionists. Don't cherrypick easy wins and ignore harder issues. For each point raised:
- Fix it, OR
- Explain specifically why it's not applicable (with real justification, not convenience)

**The bar for ignoring feedback is HIGH.** Only dismiss a suggestion if it would dramatically increase complexity (like doubling the size of an already large PR). If a suggestion would improve the PR and can reasonably be done, do it.

Use common sense — if a reviewer suggests building a massive test framework for a small change, that's obviously overkill. But don't dismiss feedback just because it's inconvenient or would require more work.

**Never ignore tests to make them pass.** Flaky tests are broken tests — fix the root cause, don't hide the symptom.

**Never remove existing tests or fix code.** If tests are failing, understand why and fix the underlying issue. Removing tests that catch bugs is how regressions happen.

### Waiting for CI

CI typically takes ~20 minutes. Use:

```bash
gh pr checks <PR-NUMBER> --watch
```

### Responding to Reviews

1. **Fix all issues** found during review before requesting re-review
2. **Respond to inline comments inline** — Don't just fix silently
3. **If you disagree**, explain your reasoning rather than ignoring the comment
4. **After fixing**, leave brief replies like "Fixed" or "Addressed in [commit SHA]"
5. **Re-request review only after substantial changes** — Don't re-ping reviewers for minor tweaks

## PR Scope

### Keep PRs Focused

- One logical change per PR
- If a fix reveals other issues, file separate issues rather than scope-creeping
- If the PR grows too large, consider splitting it (but avoid complex stacked PRs)

### Don't Cut Corners

- Don't weaken tests to make them pass
- Don't add `#[ignore]` - fix the test or don't merge
- Don't leave `TODO` comments for things you could fix now
- Don't skip edge cases because "they probably won't happen"

## Attribution

End all GitHub content (PR descriptions, comments, issues) with:

```
[AI-assisted - Claude]
```

## Checklist Before Merging

- [ ] PR title follows Conventional Commits format
- [ ] PR description explains WHY, not just WHAT
- [ ] All local checks pass (fmt, clippy, test)
- [ ] E2E tested if applicable (network/contract changes)
- [ ] Regression test added that fails without fix
- [ ] Answered "why didn't CI catch this?" and documented gap
- [ ] CI passing
- [ ] **PR review completed** via `pr-review` skill (code-first, testing, skeptical, big-picture)
- [ ] All review feedback addressed (fixed or explained why not applicable)
- [ ] All human review feedback addressed
- [ ] Responses posted to review comments

## After PR Merges

Clean up your worktree to free disk space (each worktree has its own target/ directory):

```bash
cd ~/code/freenet/freenet-core/main
git worktree remove ../fix-<issue-number>
git branch -d fix-<issue-number>  # Delete local branch
```
