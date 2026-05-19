---
name: pr-review
description: Executes comprehensive PR reviews following Freenet standards. Performs four-perspective review covering code-first analysis, testing, skeptical review, and big-picture assessment.
license: LGPL-3.0
---

# PR Reviewer

Execute a comprehensive PR review covering all four review perspectives from Freenet quality standards.

## When to Use

Use `/freenet:pr-review <PR-NUMBER>` after a PR is ready for review, before merging.

## Review Process

### Step 1: Gather PR Context

```bash
# Get PR details
gh pr view <NUMBER>

# Get the diff
gh pr diff <NUMBER>

# Check for linked issues
# Look for "Fixes #XXX" or "Closes #XXX" in description
gh issue view <ISSUE_NUMBER>  # if linked

# List affected files
gh pr diff <NUMBER> --name-only

# Check CI status
gh pr checks <NUMBER>
```

### Step 2: Code-First Review

Review the code **before** reading the PR description to form an independent understanding.

**Process:**
1. Read the diff without looking at the description
2. Answer: What does this code do? What problem does it solve?
3. Now read the PR description
4. Compare your understanding with stated intent
5. Flag any gaps or mismatches

**Look for:**
- Does the code do what I think it should?
- Are there hidden side effects?
- Is the implementation approach sound?

### Step 3: Testing Review

Analyze test coverage at all levels.

**Check for:**
- Unit tests for new/modified functions
- Integration tests for component interactions
- Simulation tests for distributed behavior (if applicable)
- E2E tests for user-facing changes

**Questions to answer:**
- Does the regression test fail without the fix and pass with it?
- Are edge cases covered?
- Are error paths tested?
- Would these tests catch similar bugs?

**Red flags:**
- No tests for bug fixes
- Tests that only check happy path
- Removed or weakened test assertions
- `#[ignore]` annotations

### Step 4: Skeptical Review

Adversarial review looking for bugs, race conditions, and edge cases.

**Attack vectors to explore:**
- Race conditions in concurrent code
- Integer overflow/underflow
- Null/None handling
- Resource leaks (memory, file handles, connections)
- Error propagation gaps
- State machine invalid transitions
- Timeout and retry edge cases

**For each change, ask:**
- What happens if this fails?
- What happens under high load?
- What happens with malicious input?
- What happens if called twice?
- What happens if called out of order?

**5 Recurring Bug Patterns (from Feb 2025 fix review — 25/25 bugs):**

Check if the PR introduces or touches code matching these patterns:

| Pattern | What to Look For |
|---------|-----------------|
| `biased;` select starvation | Per-iteration caps? Cancellation safety? Which arm starves? |
| Fire-and-forget spawns | JoinHandle stored? `try_send` on critical paths? Catch-all `_ =>` in metrics? |
| State cleanup on failure | ALL related maps cleaned up? Peer lists filtered to live connections? GC exemptions time-bounded? |
| Backoff without jitter | Jitter ±20%? Sleep interruptible via `select!`? Zero-connection re-bootstrap? Critical msgs retried? |
| Deployment gaps | Exit codes declared? Auto-update gated on release? Security tested against app needs? Unused deps? |

### Step 5: Big Picture Review

Ensure the PR actually solves the stated problem and doesn't exhibit "CI chasing" anti-patterns.

**Check for removed code:**
```bash
# Look for deleted tests or fix code
gh pr diff <NUMBER> | grep -E '^-.*#\[test\]|^-.*fn test_|^-.*assert'
```

**Anti-patterns to detect:**
| Anti-Pattern | What to Look For |
|--------------|------------------|
| Ignored tests | `#[ignore]`, `skip`, `@Ignore` |
| Weakened assertions | Looser tolerances, `.ok()` on Results |
| Commented code | Especially tests or validation |
| Magic numbers | Hardcoded values replacing logic |
| Error swallowing | `.unwrap_or_default()`, silent fallbacks |

**Big picture questions:**
1. Does this PR actually solve the stated problem?
2. Does it fully address the linked issue?
3. Does it conflict with other open PRs?
4. Does it introduce patterns that will cause future problems?
5. Is there scope creep?

### Step 6: Documentation Review

Check if documentation is complete:

- **Code docs:** Do new public items have doc comments?
- **Architecture docs:** Do changes require doc updates?
- **User docs:** Are CLI/config changes documented?
- **Stale docs:** Do any existing docs contradict the changes?

## Output Format

Produce a consolidated review report:

```markdown
## Comprehensive PR Review: #<NUMBER>

### Summary
- **PR Title:** <title>
- **Type:** <feat/fix/refactor/etc>
- **CI Status:** <passing/failing/pending>
- **Linked Issues:** <issue numbers or "none">

---

### Code-First Analysis
**Independent Understanding:** <what the code appears to do>
**Stated Intent:** <from PR description>
**Alignment:** <matches/partially matches/misaligned>
**Gaps:** <any discrepancies>

---

### Testing Assessment
**Coverage Level:** <adequate/insufficient/excessive>

| Test Type | Status | Notes |
|-----------|--------|-------|
| Unit | ✅/❌/⚠️ | <details> |
| Integration | ✅/❌/⚠️ | <details> |
| Simulation | ✅/❌/N/A | <details> |
| E2E | ✅/❌/N/A | <details> |

**Regression Test:** <present and valid / missing / insufficient>
**Missing Tests:** <list specific gaps>

---

### Skeptical Findings
**Risk Level:** <low/medium/high>

| Concern | Severity | Location | Details |
|---------|----------|----------|---------|
| <issue> | <high/med/low> | <file:line> | <explanation> |

---

### Big Picture Assessment
**Goal Alignment:** <yes/partial/no>
**Anti-Patterns Detected:** <list or "none">
**Removed Code Concerns:** <list or "none">
**Scope Assessment:** <focused/some creep/significant creep>

---

### Documentation
- Code docs: <complete/incomplete/missing>
- Architecture docs: <up-to-date/needs-update/n/a>
- User docs: <up-to-date/needs-update/n/a>

---

### Recommendations

#### Must Fix (Blocking)
1. <critical issues that must be addressed>

#### Should Fix (Important)
1. <significant issues that should be addressed>

#### Consider (Suggestions)
1. <minor improvements or style suggestions>

---

### Verdict
**State:** <Ready to Merge / Needs Changes — Re-review Required After Fix / Needs Changes — Light Re-Check Sufficient / Needs Discussion>
**HEAD SHA reviewed:** <sha>

<If not ready, summarize what's needed. If re-review is required, list which findings triggered it so the next pass can confirm they're addressed.>
```

## Parallel Subagent Reviews

For deeper analysis, spawn the specialized review agents in parallel using the Task tool with `subagent_type="general-purpose"`. Include the agent definition (from `agents/`) in each prompt so the subagent follows the correct review methodology.

```
Spawn all four in parallel using Task tool (all use subagent_type="general-purpose"):

1. "You are a code-first-reviewer. [Include agents/code-first-reviewer.md instructions]
    Review PR #<NUMBER> in freenet/freenet-core"

2. "You are a testing-reviewer. [Include agents/testing-reviewer.md instructions]
    Review test coverage for PR #<NUMBER> in freenet/freenet-core"

3. "You are a skeptical-reviewer. [Include agents/skeptical-reviewer.md instructions]
    Do a skeptical review of PR #<NUMBER> in freenet/freenet-core"

4. "You are a big-picture-reviewer. [Include agents/big-picture-reviewer.md instructions]
    Do a big-picture review of PR #<NUMBER> in freenet/freenet-core"
```

## External Skeptical Review with Codex

After completing the internal review, ask Codex to do a skeptical review of the PR. Codex uses a different model and catches different classes of issues — having an independent perspective reduces blind spots. Share the PR number and ask it to look for bugs, race conditions, edge cases, and failure modes. Incorporate any findings into the final review report.

## Re-Review After Fixes (Mandatory When Findings Were Significant)

A review is per-CODE-CONTENT, not per-PR. If the review surfaced significant problems and the author then pushed fixes, the previously-completed review is **stale** and does not authorize merge — the new code has not been reviewed. Run the full review process again on the updated HEAD.

### When re-review is required

Re-run the full review (Steps 1–6, parallel subagents, and Codex) if **any** of the following is true after fixes are pushed:

- **One or more "Must Fix" (blocking) findings** were addressed — even a single blocking fix can introduce its own bugs.
- **Three or more "Should Fix" findings** were addressed in aggregate — many small changes compound into substantial new surface area.
- **Any finding in a high-risk area** was addressed: security, cryptography, state authorization, contract/delegate migration, concurrency, persistence, wire format, deployment.
- **The diff changed by more than ~30 lines** in response to review, regardless of severity classification.
- **Conflict resolution during rebase, `git commit --amend`, or any force-push** altered the diff vs. main — this counts as new code even if no review finding prompted it. (See `~/.claude/rules/multi-model-review.md`.)

When in doubt, re-review. The cost of a second pass is small; the cost of merging unreviewed code is large.

### When a follow-up pass can be lighter

Only skip re-review if all of these hold:

- All findings were trivially mechanical (typo, comment wording, rename of a private symbol).
- No "Must Fix" findings existed.
- The diff vs. the previously-reviewed HEAD is purely additive and obviously safe (e.g. a CHANGELOG line, a version bump, a single `// TODO` comment).
- No rebase or amend occurred.

In that case, do a focused diff-of-the-diff check (just the new commits since the prior review) and note in the verdict that a light re-check was performed rather than a full re-review.

### How to re-review

1. Confirm CI is green on the **current HEAD SHA**, not the SHA you reviewed last time:
   ```bash
   gh pr view <NUMBER> --json statusCheckRollup,headRefOid
   ```
2. Re-run Steps 1–6 against the new HEAD. Read the *full* diff again, not just the fix commits — context shifts when code moves.
3. Re-spawn the four parallel subagent reviews against the new HEAD.
4. Re-run Codex review against the new HEAD.
5. Produce a fresh review report. In the **Verdict** section, explicitly note this is a re-review and reference the prior review's findings: "Re-review after fixes for findings #1, #3, #5 from prior pass — all resolved; one new concern at X."
6. If the new review surfaces its own significant findings, repeat the cycle. There is no cap on rounds; merge only when a review pass on the current HEAD comes back clean (or with only trivial findings the user accepts).

### Verdict states involving re-review

Extend the Output Format's Verdict to one of:

- **Ready to Merge** — review pass on current HEAD is clean or only trivial findings remain.
- **Needs Changes — Re-review Required After Fix** — significant findings exist; author must address them AND a fresh review must run on the updated HEAD before merge.
- **Needs Changes — Light Re-Check Sufficient** — only trivial mechanical findings; a diff-of-the-diff pass on the fix commits is enough.
- **Needs Discussion** — design-level disagreement that fixes alone won't resolve.

Never use "Ready to Merge" on the basis of a review whose HEAD SHA differs from the current PR HEAD.

## Quality Standards

- Be thorough but constructive
- Cite specific files and line numbers
- Explain WHY something is a problem, not just WHAT
- Suggest fixes, not just criticisms
- Acknowledge what's done well
- Don't nitpick style if it matches codebase conventions
