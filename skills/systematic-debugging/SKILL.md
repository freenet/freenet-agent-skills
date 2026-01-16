---
name: freenet-systematic-debugging
description: Methodology for debugging non-trivial problems systematically. This skill should be used automatically when investigating bugs, test failures, or unexpected behavior that isn't immediately obvious. Emphasizes hypothesis formation, parallel investigation with subagents, and avoiding common anti-patterns like jumping to conclusions or weakening tests.
license: LGPL-3.0
---

# Systematic Debugging

## When to Use

Invoke this methodology automatically when:
- A test fails and the cause isn't immediately obvious
- Unexpected behavior occurs in production or development
- An error message doesn't directly point to the fix
- Multiple potential causes exist

## Core Principles

1. **Hypothesize before acting** - Form explicit hypotheses about root cause before changing code
2. **Test hypotheses systematically** - Validate or eliminate each hypothesis with evidence
3. **Parallelize investigation** - Use subagents for concurrent readonly exploration
4. **Preserve test integrity** - Never weaken tests to make them pass

## Debugging Workflow

### Phase 1: Reproduce and Isolate

1. **Reproduce the failure** - Confirm the bug exists and is reproducible
2. **Create a failing unit test** (when practical) - Captures the bug and verifies the fix
   - Not always possible (environment-specific issues, race conditions)
   - Don't spend excessive time if a test isn't natural to write
3. **Gather initial evidence** - Read error messages, logs, stack traces

### Phase 2: Form Hypotheses

Before touching any code, explicitly list potential causes:

```
Hypotheses:
1. [Most likely] The X component isn't handling Y case
2. [Possible] Race condition between A and B
3. [Less likely] Configuration mismatch in Z
```

Rank by likelihood based on evidence. Avoid anchoring on the first idea.

### Phase 3: Investigate Systematically

**For each hypothesis:**
1. Identify what evidence would confirm or refute it
2. Gather that evidence (logs, code reading, adding debug output)
3. Update hypothesis ranking based on findings
4. Move to next hypothesis if current one is eliminated

**Parallel investigation with subagents:**
- Spawn subagents for independent, readonly investigations
- Good candidates: searching for similar patterns, reading related code, checking git history
- Each agent investigates one hypothesis or gathers one type of evidence
- Only parallelize readonly tasks - code changes must be sequential
- Use judgment on when parallelization helps vs. adds overhead

Example:
```
Spawning 3 agents in parallel:
- Agent 1: Search for similar error handling in codebase
- Agent 2: Check git history for recent changes to affected module
- Agent 3: Read the test file and related fixtures
```

### Phase 4: Fix and Verify

1. **Fix the root cause** - Not symptoms
2. **Verify the fix** - The failing test (or reproduction steps) now passes
3. **Check for regressions** - Run related tests
4. **Consider edge cases** - Does the fix handle similar scenarios?

### Phase 5: Test Coverage Analysis

**Always ask: "Why didn't CI catch this?"**

Projects typically have multiple layers of testing:
- Unit tests for individual components
- Integration tests for component interactions
- Network simulations (e.g., multi-peer regression tests in CI workflows)
- E2E tests with real infrastructure

If a bug reached production or manual testing, there's a gap in coverage. Investigate:

1. **Which test layer should have caught this?**
   - Logic error → unit test
   - Component interaction bug → integration test
   - Distributed system behavior → network simulation
   - Real-world scenario → E2E test

2. **Why didn't the existing tests catch it?**
   - Tests use different topology/configuration than production
   - Tests mock components that exhibit the bug in real usage
   - Edge case not covered by existing test scenarios
   - Test assertions too weak to detect the failure

3. **Document the gap** - Include in the issue/PR:
   - What test would have caught this
   - Why existing tests didn't (e.g., "tests use networks where all nodes have the contract before Subscribe")
   - Whether a new test should be added to prevent regression

## Anti-Patterns to Avoid

### Jumping to conclusions
- **Wrong:** See error, immediately change code that seems related
- **Right:** Form hypothesis, gather evidence, then act

### Tunnel vision
- **Wrong:** Spend hours on one theory despite contradicting evidence
- **Right:** Set time bounds, pivot when evidence points elsewhere

### Weakening tests
- **Wrong:** Test fails, reduce assertions or add exceptions to make it pass
- **Right:** Understand why the test expects what it does, fix the code to meet that expectation
- **Exception:** The test itself has a bug or tests incorrect behavior (rare, requires clear justification)

### Sequential investigation when parallel is possible
- **Wrong:** Read file A, wait, read file B, wait, read file C
- **Right:** Spawn agents to read A, B, C concurrently, synthesize findings

### Fixing without understanding
- **Wrong:** Copy a fix from Stack Overflow that makes the error go away
- **Right:** Understand why the fix works and whether it addresses root cause

## Checklist Before Declaring "Fixed"

- [ ] Root cause identified and understood
- [ ] Fix addresses root cause, not symptoms
- [ ] Original failure no longer reproduces
- [ ] No new test failures introduced
- [ ] Test added if one didn't exist (when practical)
- [ ] No test assertions weakened or disabled
- [ ] Answered "why didn't CI catch this?" and documented the test gap
