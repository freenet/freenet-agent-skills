---
name: freenet-pr-creation
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

**Before running review agents**, use the code-simplifier subagent to clean up and simplify the code:

```
Task tool with subagent_type="code-simplifier:code-simplifier":

"Review and simplify the code changes in PR #<NUMBER> (branch-name) at /path/to/worktree

Focus on the recently modified files:
- [list modified files]

Look for opportunities to simplify while preserving functionality."
```

The code-simplifier will:
- Remove redundant conditionals and dead code
- Condense verbose documentation
- Simplify complex tests while preserving assertions
- Fix any issues introduced by the changes

**Commit any simplifications before running reviews** - this ensures reviewers see the cleanest version of the code.

### Parallel Subagent Reviews

Once the PR is complete, code is simplified, and CI is passing, spawn **four review agents in parallel** using the Task tool. Each has a different focus:

#### 1. Code-First Review

```
"Review PR #<NUMBER> in freenet/freenet-core using this process:

STEP 1 - Code only: Read ONLY the code changes (use `gh pr diff`). Do NOT read
the PR description or comments yet. Form your own understanding of:
- What the code actually does
- What problem it appears to solve
- Any concerns about the implementation

STEP 2 - Compare: NOW read the PR description and comments. Compare your
understanding with the stated intent. Report:
- Any discrepancies between code behavior and description
- Behavior changes not mentioned in the description
- Description claims not reflected in the code
- Anything that confused you that should be documented"
```

#### 2. Testing Review

```
"Review test coverage for PR #<NUMBER> in freenet/freenet-core.

Analyze whether the changes are adequately tested at appropriate levels:
- Unit tests: Are individual functions/methods tested?
- Integration tests: Are component interactions tested?
- Simulation tests: For network/distributed behavior, is six-peer-regression
  or similar CI simulation sufficient?

Check BOTH:
- Direct changes: Is the new/modified code tested?
- Downstream impact: Does this change behavior of calling code? Is THAT tested?

Flag any scenarios that could break but aren't tested. Be specific about what
test is needed, not just 'needs more tests'.

Note: We've had serious regression problems. Be thorough. However, don't
suggest tests that would significantly slow CI without strong justification."
```

#### 3. Skeptical Review

```
"Do a skeptical review of PR #<NUMBER> in freenet/freenet-core.

Assume there are bugs until proven otherwise. Look for:
- Logic errors or edge cases not handled
- Race conditions or concurrency issues
- Missing error handling or error propagation
- Resource leaks
- Performance issues (especially in hot paths)
- Security concerns

Be adversarial - how could this code fail in production?"
```

#### 4. Big Picture Review

This review catches "CI chasing" - when an agent fixes symptoms to make tests pass while losing sight of the actual goal. **Real example:** An agent working on a congestion control fix removed tests and fix code that another developer had written, causing a regression. The agent was focused on making CI pass, not on solving the actual problem.

```
"Do a big-picture review of PR #<NUMBER> in freenet/freenet-core.

CONTEXT GATHERING:
1. Read the PR title and description to understand stated intent
2. Check for linked issues (look for 'Fixes #XXX', 'Closes #XXX' in description)
   - If found, read the full issue: gh issue view <NUMBER>
   - Understand what the issue actually asks for
3. List open PRs: gh pr list --state open --limit 20
4. List recently merged PRs: gh pr list --state merged --limit 10
5. Note any related or overlapping work

REMOVED CODE DETECTION (CRITICAL):
Check if this PR removes code that was recently added:
- Compare against recent commits on main that touched the same files
- Look for removed tests - especially tests added to catch specific bugs
- Look for removed fix code - not just tests, but actual fixes
- If the PR is based on another branch/PR, verify ALL changes are included

ANTI-PATTERN DETECTION:
Look for signs of 'CI chasing' - changes that solve symptoms not problems:
- #[ignore] or skip annotations on tests
- Weakened assertions (looser tolerances, removed checks, .ok() on Results)
- Commented-out code (especially tests or validation)
- TODO/FIXME that defer obviously-needed work
- Hardcoded values replacing dynamic logic
- Error swallowing (.unwrap_or_default(), silent fallbacks)
- Backwards-compat shims (_unused renames, re-exports of removed items)

BIG PICTURE QUESTIONS:
- Does this PR actually solve the stated problem, or just make tests pass?
- If linked to an issue, does the PR fully address what the issue asks for?
- Does it conflict with or duplicate work in other open/recent PRs?
- Does it introduce patterns that will cause future problems?
- Is there scope creep - changes unrelated to the stated goal?
- Would a human reviewer be surprised by any of these changes?
- Are there commits from related work that should be included but aren't?"
```

#### Handling Review Feedback

**Take all feedback seriously.** Freenet is complex code and we need to be perfectionists. Don't cherrypick easy wins and ignore harder issues. For each point raised:
- Fix it, OR
- Explain specifically why it's not applicable (with real justification, not convenience)

**The bar for ignoring feedback is HIGH.** Only dismiss a suggestion if it would dramatically increase complexity (like doubling the size of an already large PR). If a suggestion would improve the PR and can reasonably be done, do it.

Use common sense - if a reviewer suggests building a massive test framework for a small change, that's obviously overkill. But don't dismiss feedback just because it's inconvenient or would require more work.

**Never ignore tests to make them pass.** Pre-commit hooks will reject `#[ignore]`. Flaky tests are broken tests - fix the root cause, don't hide the symptom.

**Never remove existing tests or fix code.** If tests are failing, understand why and fix the underlying issue. Removing tests that catch bugs is how regressions happen.

### Waiting for CI

CI typically takes ~20 minutes (as of Dec 2025). Use:

```bash
gh pr checks <PR-NUMBER> --watch
```

Or sleep and then check:

```bash
sleep 900  # 15 minutes, then check status
gh pr checks <PR-NUMBER>
```

### Responding to Reviews

1. **Fix all issues** found during review before requesting re-review
2. **Respond to inline comments inline** - Don't just fix silently
3. **If you disagree**, explain your reasoning rather than ignoring the comment
4. **After fixing**, leave brief replies like "Fixed" or "Addressed in [commit SHA]"
5. **Re-request review only after substantial changes** - Don't re-ping reviewers for minor tweaks; only request re-review when you've addressed significant feedback or made meaningful changes

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
- [ ] **Four parallel subagent reviews completed** (code-first, testing, skeptical, big-picture)
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
