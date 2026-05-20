---
name: pr-review
description: Executes a risk-tiered, multi-perspective PR review — triages the change, runs specialist subagents in parallel (code-first, testing, skeptical, big-picture) plus an external model pass scaled to risk, then posts a consolidated review to the PR.
license: LGPL-3.0
---

# PR Reviewer

Run a comprehensive PR review covering all four Freenet review perspectives, plus an
external (non-Claude) model, and post a consolidated review to the PR.

## When to Use

Invoke `/freenet:pr-review <PR-NUMBER>` after a PR is ready for review, before merging.
The PR number is passed as the skill argument (`$1`); if none is given, detect the PR
for the current branch with `gh pr view --json number -q .number`.

## How This Skill Works

This skill **orchestrates** a review — it does not do all the perspectives by hand.
It checks out the PR, triages the change to a risk tier, spawns specialist subagents
in parallel (scaled to that tier) plus an external model pass, reconciles their
findings into one report, and posts that report to the PR.

The four subagents ship with this plugin as first-class agent types — invoke them
directly with the `Agent` tool's `subagent_type` parameter. Do **not** paste agent
definitions into a `general-purpose` prompt; that is obsolete.

## Step 1: Check Out the PR, Gather Context, and Triage Risk

**Critical:** reviewers must read the PR's *actual code*, and the review must not
disturb the user's working tree. Check the PR out into a **dedicated worktree** — do
NOT use `gh pr checkout`, which switches the user's working branch and drags any
uncommitted changes onto the PR branch, contaminating the review.

```bash
PR=<PR-NUMBER>          # the $1 skill argument

git fetch origin "pull/$PR/head"
REVIEW_DIR="$(mktemp -d)/pr-$PR"
git worktree add --detach "$REVIEW_DIR" FETCH_HEAD   # PR code, isolated
cd "$REVIEW_DIR"                                     # run the review from here
```

Gather context (from the worktree):

```bash
gh pr view "$PR"
gh pr diff "$PR" --name-only
gh pr checks "$PR"                    # CI status
gh issue view <ISSUE_NUMBER>          # linked issue (from "Fixes #" / "Closes #")

# Existing review feedback — read it so the review ADDRESSES it, not duplicates it:
gh pr view "$PR" --json comments,reviews
gh api repos/{owner}/{repo}/pulls/"$PR"/comments   # inline review comments
```

The `gh api .../comments` call above is the reliable way to get inline comments —
they are easy to miss. (If your environment provides a `gh-pr-interactions` skill, it
documents the comment API in more depth.)

**Large diffs:** if the diff exceeds ~2000 changed lines or ~40 files, instruct each
subagent to review by file batches rather than loading the whole diff into context.

**Cleanup (mandatory — do this even if the review aborts partway):** remove the
worktree with `git worktree remove --force "$REVIEW_DIR"`.

Do NOT run a code-simplifier or any other mutating step here — this skill reviews the
PR as submitted; editing the checked-out code would make reviewers judge something
other than the PR.

### Pick the Risk Tier

Choose the tier by checking these in order — **first match wins** — or honor an
explicit tier the user named (e.g. "full review of PR 42"):

1. **Skip** — the *entire* diff is mechanical: typo / comment-only / formatting /
   version bump / CHANGELOG-only. Judge this against the whole diff, not the PR title —
   a PR labelled "version bump" that also edits logic is **not** Skip. Report
   "trivial — CI is the only gate" and **stop**; do not spawn reviewers.
2. **Full** — the change touches a high-risk surface (below), OR the diff is large or
   cross-cutting, OR you are genuinely uncertain. Run the complete process.
3. **Light** — everything else: a low-to-moderate-risk change with no high-risk
   surface. Spawn a reduced reviewer set (Step 2) plus the external model pass (Step 3).

These tiers are exhaustive — Light is the catch-all. When torn between two, pick the
heavier one.

**High-risk surfaces — always Full:** concurrency / async, cryptography / security /
auth, state authorization, data or schema migration, wire format / protocol /
serialization (freenet-stdlib enums), consensus / routing, transport / NAT traversal,
contract or delegate WASM, deploy / release / CI config.

State the chosen tier and the one-line reason before proceeding.

## Step 2: Spawn the Review Subagents in Parallel

Spawn the reviewers with the `Agent` tool in a **single message** so they run
concurrently, each with `run_in_background: true`. Which reviewers run depends on the
tier picked in Step 1:

- **Full** — spawn all four.
- **Light** — spawn `freenet:skeptical-reviewer`; also spawn `freenet:big-picture-reviewer`
  if the diff removes code or spans multiple components.

| `subagent_type` | Perspective |
|-----------------|-------------|
| `freenet:code-first-reviewer` | Reads the code before the description; flags gaps between stated intent and implementation |
| `freenet:testing-reviewer` | Test-coverage gaps at unit / integration / simulation / E2E levels |
| `freenet:skeptical-reviewer` | Adversarial — bugs, race conditions, edge cases, failure modes |
| `freenet:big-picture-reviewer` | Goal alignment, removed tests/fixes, scope creep, stale skills/docs |

These `subagent_type` values are plugin-namespaced: `freenet:` is the plugin name and
the files in `agents/` carry the bare name (`skeptical-reviewer`, etc.). Use the
`freenet:`-prefixed form exactly as shown.

In each subagent's prompt, include: the PR number, the repo (`owner/repo`), and the
path to the review worktree from Step 1 (`$REVIEW_DIR`), so the agent can `Read`/`Grep`
the PR's actual code — not just the diff — for surrounding context. Each agent already
carries its own review methodology; you do not need to supply it.

## Step 3: External Model Review (runs concurrently with Step 2)

Run this for **both Light and Full** tiers — the external model is the highest-value
single pass, because its blind spots do not correlate with Claude-authored code.
Spawn it concurrently with Step 2's subagents. Run a non-Claude model against the
review worktree:

```bash
codex review --base main
```

(If your environment provides a `codex-review` skill, it wraps this command.) For a
Full review of a high-risk PR, add a third independent model when one is available —
e.g. a `gemini-cli-review` skill or the `gemini` CLI.

## Step 4: Freenet Bug-Pattern Check

Do this for **Full** reviews, and for **Light** reviews whose change has non-trivial
logic.

When reviewing **freenet-core**, the canonical and continuously-updated bug-pattern
list lives at `.claude/rules/bug-prevention-patterns.md` in that repo. Read it and
check the PR against every pattern listed there — it supersedes any snapshot in this
skill or in the subagent definitions.

Recurring patterns (non-exhaustive — the in-repo file is authoritative): `biased;`
select starvation, fire-and-forget spawns, incomplete state cleanup on failure,
backoff without jitter, `.send().await` on bounded channels inside event/recv loops,
protocol-enum / wire-format breaks for older consumers, paired `Option` fields that
must co-occur, and manually-mirrored telemetry counters that rot after op migrations.

## Step 5: Synthesize — Reconcile and Verify

When all spawned subagents and the external model pass have returned, **do not just
concatenate their reports.** Synthesize:

1. **Deduplicate** — the same finding will surface from multiple reviewers; merge it
   into one entry.
2. **Reconcile contradictions** — if two reviewers disagree, investigate the code
   yourself and decide; note the disagreement in the report if it is genuinely open.
3. **Verify before reporting** — subagents and Codex can cite wrong line numbers or
   hallucinate. Open every cited `file:line` and confirm the finding is real before it
   goes in the report. Drop false positives; downgrade speculative ones to questions.
4. **Classify severity** — map every surviving finding to Must Fix / Should Fix /
   Consider (see Output Format).
5. **Check documentation** — new public items have doc comments? CLI/config changes
   documented? Any existing doc now contradicted by the change?

## Step 6: Post the Consolidated Review to the PR

Post the synthesized report to the PR as a review comment:

```bash
gh pr review "$PR" --comment --body-file <report-file>
```

Use `--comment` — not `--approve` or `--request-changes`. This skill produces a
review; it does not gate merge or speak for a human approver. Also print the report
in the conversation. End the posted body with `[AI-assisted - Claude]`.

## Output Format

Produce a consolidated review report:

```markdown
## Comprehensive PR Review: #<NUMBER>

### Summary
- **PR Title:** <title>
- **Type:** <feat/fix/refactor/etc>
- **CI Status:** <passing/failing/pending>
- **Linked Issues:** <issue numbers or "none">
- **Review tier:** <Light / Full>
- **Reviewers run:** <which reviewers and external models actually ran>

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
| <issue> | <high/med/low> | <file:line — verified> | <explanation> |

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

[AI-assisted - Claude]
```

## Re-Review After Fixes (Mandatory When Findings Were Significant)

A review is per-CODE-CONTENT, not per-PR. If the review surfaced significant problems and the author then pushed fixes, the previously-completed review is **stale** and does not authorize merge — the new code has not been reviewed. Run the full review process again on the updated HEAD.

### When re-review is required

Re-run the full review (all of Steps 1–6) if **any** of the following is true after fixes are pushed:

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
2. Re-run all of Steps 1–6 against the new HEAD — re-create the review worktree,
   re-triage, re-spawn the tier's reviewers, and re-run the external model pass. Read
   the *full* diff again, not just the fix commits — context shifts when code moves.
   Re-triage against the **whole PR diff vs. base**, not just the fix commits: the
   tier may rise but never falls below the original review's tier (a PR that needed a
   Full review does not become Skip because the last fix was one line).
3. Produce a fresh review report. In the **Verdict** section, explicitly note this is a re-review and reference the prior review's findings: "Re-review after fixes for findings #1, #3, #5 from prior pass — all resolved; one new concern at X."
4. If the new review surfaces its own significant findings, repeat the cycle. There is no cap on rounds; merge only when a review pass on the current HEAD comes back clean (or with only trivial findings the user accepts).

### What the re-review verdict states mean

The Verdict states (defined in Output Format) are:

- **Ready to Merge** — review pass on current HEAD is clean or only trivial findings remain.
- **Needs Changes — Re-review Required After Fix** — significant findings exist; author must address them AND a fresh review must run on the updated HEAD before merge.
- **Needs Changes — Light Re-Check Sufficient** — only trivial mechanical findings; a diff-of-the-diff pass on the fix commits is enough.
- **Needs Discussion** — design-level disagreement that fixes alone won't resolve.

Never use "Ready to Merge" on the basis of a review whose HEAD SHA differs from the current PR HEAD.

## Quality Standards

- Be thorough but constructive
- Cite specific files and line numbers — and verify each citation before reporting it
- Explain WHY something is a problem, not just WHAT
- Suggest fixes, not just criticisms
- Acknowledge what's done well
- Don't nitpick style if it matches codebase conventions
