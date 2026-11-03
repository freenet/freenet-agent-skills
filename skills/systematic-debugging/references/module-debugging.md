# Module-Specific Debugging Guide

Bug patterns per Freenet module. Test framework details (the `#[freenet_test]` macro, event capture, simulation runners) are in freenet-core's `.claude/rules/testing.md` and `docs/architecture/testing/`. The module rules in `.claude/rules/` (`transport.md`, `ring.md`, `operations.md`, `contracts.md`) hold the "must" rules for each area.

## Observing a Multi-Node Test

`#[freenet_test]` collects events from every node. After the test, aggregate them:

```rust
let aggregator = ctx.aggregate_events().await?;
let events = aggregator.get_all_events().await?;

// Inspect specific transaction flow
let flow = aggregator.get_transaction_flow(&tx_id).await?;

// Get routing path a transaction took
let path = aggregator.get_routing_path(&tx_id).await?;

// Export Mermaid diagram of event flow
let diagram = aggregator.export_mermaid_graph(&tx_id).await?;
```

Set `aggregate_events = "always"` to see events on success too. Failure reports are written to `/tmp/freenet-test-*` with per-peer timelines and Mermaid sequence diagrams.

---

## Module: transport/

**What it does:** UDP communication with encryption (X25519 + AES-128-GCM), congestion control (FixedRate by default; LEDBAT++ and BBR available), NAT traversal, streaming.

| Pattern | How to Detect |
|---------|---------------|
| Nonce reuse | Encryption tests — verify counter-based nonces never repeat |
| NAT hole-punch timing | Connection establishment failures in simulation with >2 nodes |
| Packet reordering | Assertion failures in streaming reassembly; UDP has no ordering guarantee |
| Congestion window miscalculation | Throughput tests at various RTTs (10ms, 50ms, 100ms, 200ms) |
| Keep-alive timeout | Unexpected disconnections; check 5-second ping interval, 120s idle timeout |
| Decryption failure handling | Must drop silently + debug log only; never propagate or disconnect |
| `TimeSource` violation | Using `std::time::Instant::now()` instead of trait — breaks simulation determinism |

Use the `Socket` trait, never `tokio::net::UdpSocket` directly, so `SimulationSocket` works in tests.

---

## Module: operations/

Each operation (CONNECT, GET, PUT, UPDATE, SUBSCRIBE) runs as one spawned driver task per transaction; state lives in task locals. See `.claude/rules/operations.md` and `docs/architecture/operations/README.md` before debugging here.

| Pattern | How to Detect |
|---------|---------------|
| Driver exits without publishing a result | Client hangs; check every exit path publishes its `HostResult` |
| Terminal-reply side effects hand-inlined and one omitted | Op reports success while a downstream effect (caching, subscription, telemetry) is silently missing; see `bug-prevention-patterns.md` |
| Streaming threshold | Payloads near the 64KB boundary; `should_use_streaming()` decides streaming vs non-streaming |
| Timeout not cleaned | Stale transactions; `garbage_cleanup_task` sweeps every 5 s |
| `InvalidStateTransition` in logs | `(state, message)` mismatch in a relay or joiner helper |

---

## Module: ring/

**What it does:** DHT topology, peer location assignment, distance calculations, routing decisions, connection management (25 min / 200 max bounds).

| Pattern | How to Detect |
|---------|---------------|
| Location hash drift | Contract locations outside [0.0, 1.0] range |
| Connection bound violations | More than 200 or fewer than 25 connections |
| Routing loops | Same peer visited twice; check visited-peer filter |
| Distance calculation error | Non-symmetric distance, incorrect wrap-around at ring boundary |
| Self-connection | Node connecting to itself; must be rejected |
| Incorrect peer selection | `k_closest_potentially_hosting()` not filtering transient connections |
| Accept-at-terminus violation | Accepting when closer peers exist instead of forwarding |

Use `PeerKeyLocation` as the identifier, never a raw `SocketAddr`, and handle missing location entries with `.get()`.

---

## Module: contract/

**What it does:** WASM sandbox execution (wasmtime) for contracts, state management, delta merges, related contract resolution.

| Pattern | How to Detect |
|---------|---------------|
| State merge non-commutativity | Apply deltas A then B vs B then A — results differ |
| State merge non-associativity | (A + B) + C != A + (B + C) |
| Memory limit violation | Contract consumes more than sandbox allows |
| Execution timeout | Contract runs longer than time limit |
| Host memory leak | Host function returns pointer to host memory instead of copying |
| Circular dependency | Contract A depends on B depends on A |
| Invalid state stored | Storing state that fails the contract's own validation |

Test helpers: `ensure_contract_compiled(name)` and the state builders `create_minimal_state()`, `create_large_todo_list()` (~1MB, streaming threshold), `create_oversized_todo_list()` (>10MB, rejection) and `create_max_tasks_todo_list()` in `test_utils`.

---

## Fault Injection Reference

`FaultConfig` is available for any simulation test. Use it to reproduce conditions that are hard to hit naturally.

```rust
let fault_config = FaultConfigBuilder::new()
    .message_loss_rate(0.1)           // 10% packet loss
    .latency_range(Duration::from_millis(50)..Duration::from_millis(200))
    .partition(
        // start time is virtual nanoseconds; heals after the duration
        Partition::new(set_a, set_b)
            .with_duration(10_000_000_000, Duration::from_secs(20))
    )
    .node_crash_rate(0.01)            // 1% chance of node crash
    .build();
```

Verify the fault actually occurred: `sim.get_network_stats()` should show the configured loss rate and the partition window.
