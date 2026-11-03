---
name: systematic-debugging
description: Methodology for debugging non-trivial problems systematically. This skill should be used automatically when investigating bugs, test failures, or unexpected behavior that isn't immediately obvious. Emphasizes hypothesis formation, parallel investigation with subagents, and avoiding common anti-patterns like jumping to conclusions or weakening tests.
license: LGPL-3.0
---

# Systematic Debugging

## When to Use

Invoke this methodology when a test fails and the cause isn't immediately obvious, when unexpected behavior occurs in production or development, when an error message doesn't point to the fix, or when several causes are plausible.

Form explicit hypotheses before changing code, validate or eliminate each with evidence, and use subagents for concurrent readonly exploration.

## Debugging Scope Ladder

**Always prefer the smallest, most reproducible scope that demonstrates the bug.** Work up the ladder only when the smaller scope can't reproduce or doesn't apply:

| Priority | Scope | When to Use | Command |
|----------|-------|-------------|---------|
| 1 | **Unit test** | Logic errors, algorithm bugs, single-function issues | `cargo test -p freenet -- specific_test` |
| 2 | **Mocked unit test** | Transport/ring logic needing isolation | Unit test with `MockNetworkBridge` / `MockRing` |
| 3 | **Simulation test** | Multi-node behavior, state machines, race conditions | `cargo test -p freenet --features simulation_tests,testing --test simulation_integration` |
| 4 | **SimNetwork + FaultConfig** | Fault tolerance, message loss, network partitions | SimNetwork with configured fault injection |
| 5 | **fdev single-process** | Quick multi-peer CI validation | `cargo run -p fdev -- test --seed 42 single-process` |
| 6 | **freenet-test-network** | 20+ peer large-scale behavior | Docker-based `freenet-test-network` |
| 7 | **Real network** | Issues that only manifest with real UDP/NAT/latency | Manual multi-peer test across machines |

Lower scopes are faster, deterministic and reproducible by anyone. Gateway logs, aggregate telemetry and production metrics are not available to every developer, so don't design a reproduction that depends on them.

## Debugging Workflow

### Phase 0: Claim the Issue

If you're working on a GitHub issue, claim it first (see the pr-creation skill's "Claim the Issue").

### Phase 1: Reproduce and Isolate

1. **Reproduce the failure** at the smallest scope on the ladder that shows it.
2. **Record the seed** when using simulation tests, so the run is reproducible.
3. **Gather initial evidence:** error messages, logs, stack traces.

```bash
# Run simulation tests
cargo test -p freenet --features simulation_tests,testing --test simulation_integration

# With logging, to observe event sequences
RUST_LOG=info cargo test -p freenet --features simulation_tests,testing --test simulation_integration -- --nocapture

# Reproduce with a specific seed
cargo run -p fdev -- test --seed 0xDEADBEEF single-process
```

### Phase 1b: When the Bug Is Reported from the Live Network

Live-network debugging has the slowest feedback loop (add telemetry, redeploy, wait), so translate the observation into a local reproduction as fast as possible.

1. **Constrain the problem from network data:** which operation type, which peers, what hop count, what timing pattern.
2. **Translate constraints into simulation parameters:**

| Network Observation | Simulation Translation |
|---------------------|----------------------|
| "GET times out at hop 3" | `#[freenet_test]` with 4+ nodes, specific `node_locations` matching topology |
| "Peer X never responds" | Node configured to drop/delay messages via `FaultConfig` |
| "High timeout rate" | A `FaultConfig` loss rate tuned until the simulated rate matches |
| "Works for PUT but not GET" | Test both operations — likely incomplete wiring in dispatch path |

3. **Write the simulation test** with `#[freenet_test]` or `SimNetwork + FaultConfig` and a deterministic seed.
4. **Debug locally** with full control (tracing, assertions, state inspection), no redeployment.
5. **Validate** the fix against telemetry if you can.

Once you know *what* fails (operation type, peer pattern, timing), stop analyzing network data and reproduce locally; the simulation loop is orders of magnitude faster. If a `telemetry-monitor` skill is available (project-local, not part of this plugin), use it to constrain the problem, not as the primary debugging tool.

### Phase 2: Form Hypotheses

Before touching code, list the plausible causes ranked by likelihood. **Freenet-specific hypothesis patterns:**

- **State machine bugs:** invalid transitions in operations (CONNECT, GET, PUT, UPDATE, SUBSCRIBE).
- **Ring/routing errors:** incorrect peer selection, distance calculations, topology issues.
- **Transport issues:** UDP packet loss handling, encryption/decryption, connection lifecycle.
- **Contract execution:** WASM sandbox issues, state verification failures.
- **Determinism violations:** `std::time::Instant::now()` instead of `TimeSource`, or `rand::random()` instead of `GlobalRng`.
- **Silent failure:** a spawned task that died unnoticed (is the `JoinHandle` stored and polled?), a broadcast to zero targets, a channel that drops on overflow, `let _ = sender.send()`.
- **Resource exhaustion:** an insert with no cleanup on the failure or timeout path.
- **Incomplete wiring:** works for GET but not PUT/UPDATE/SUBSCRIBE; check every dispatch arm for `_ =>` catch-alls and commented-out arms.
- **TTL/timing races:** operation A can outlive timeout B (transient TTL vs CONNECT handshake, interest TTL vs subscription renewal).
- **Regressions from "safe" changes:** a simplification or changed default breaks an invariant nothing tests; check what implicit behavior the recent commit removed.
- **Mock/test divergence:** the mock skips a side effect, takes a different code path from production, or the mock socket behaves differently from real UDP.

See [Module-Specific Debugging Guide](references/module-debugging.md) for bug patterns per module.

### Phase 3: Investigate Systematically

For each hypothesis, identify the evidence that would confirm or refute it, gather it, and update the ranking.

**Evidence sources:** `RUST_LOG` output and `#[freenet_test]` event capture (everyone); simulation stats (`sim.get_network_stats()`, `sim.await_convergence(timeout, poll, min_contracts)`, `sim.virtual_time().now_nanos()`); `git log --oneline -20 -- path/to/file.rs`; gateway logs and aggregate telemetry (maintainers only; don't build a reproduction that depends on them). Module-specific techniques are in [module-debugging.md](references/module-debugging.md).

**Asserting on freenet-core logs from E2E tests: use structured fields, and read the log first.** Tail the node log with the `RUST_LOG` you will use in CI and look at what is emitted around the event. Don't copy a grep pattern from an old test: a marker that no longer exists makes a negative assertion vacuously true, a false green. Prefer structured fields (`phase="..."`, `op="GET"`, `tx=`, to follow one operation across nodes). Treat log assertions as supplementary; the authoritative check is the UI assertion or a contract GET via fdev. Logs tell you how you got there, not whether you did.

When a test fails because of a conclusively traced upstream bug (for example a freenet-core relay timeout with an open issue and a recognizable log signature), **quarantine the path, do not remove the test.** Detect the exact upstream signature, emit a Playwright `test.skip()` (or equivalent) with the issue link, and keep the assertion that would have caught it. Genuine app-side regressions (contract errors, deserialization, panics, wrong state) still fail the gate. Removing or weakening the assertion loses the coverage you get for free the day upstream is fixed.

**Parallel investigation:** spawn `freenet:codebase-investigator` subagents, one per hypothesis or evidence type (similar error handling, recent history of the affected files, the test and its fixtures). They are readonly; you synthesize and decide. Make code changes sequentially, never in parallel.

### Phase 4: Fix and Verify

1. Fix the root cause, not the symptom.
2. Re-run the failing test with the same seed, then `cargo test -p freenet`.
3. Check that the fix handles similar scenarios, and that new code uses `TimeSource` and `GlobalRng`.

### Phase 5: Test Coverage Analysis

**Always ask: "Why didn't CI catch this?"** Name the test layer from the ladder that should have caught it, say why the existing tests missed it (different topology or config, mocks hiding the behavior, no fault injection, weak assertions, determinism bypass), and put the missing test in the issue or PR.

## Rules That Do Not Bend

- **Never weaken a test to make it pass.** A failing test is evidence; fix the code, or fix the test's logic with a stated reason.
- **Keep determinism.** Use `TimeSource` and `GlobalRng`, never `std::time::Instant::now()` or `rand::random()`, in core logic (see `.claude/rules/testing.md`), so simulation tests stay reproducible.
