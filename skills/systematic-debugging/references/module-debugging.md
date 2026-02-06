# Module-Specific Debugging Guide

Debugging strategy varies by which Freenet module is involved. Each module has different bug patterns, observation tools, and test approaches.

## Observation Infrastructure

Before diving into modules, understand what's available for capturing events:

### `#[freenet_test]` Macro

The primary tool for multi-node debugging. Provides automatic event collection, failure reporting, and node coordination.

```rust
#[freenet_test(
    nodes = ["gateway", "peer-1", "peer-2"],
    timeout_secs = 300,
    startup_wait_secs = 15,
    aggregate_events = "always",  // "on_failure" | "always" | "never"
    log_level = "freenet=debug,info",
)]
async fn test_my_scenario(ctx: TestContext) -> TestResult {
    let gateway = ctx.node("gateway")?;
    let peer = ctx.node("peer-1")?;
    // ...
}
```

**Key parameters:**
| Parameter | Default | Use When |
|-----------|---------|----------|
| `aggregate_events = "always"` | `"on_failure"` | Debugging — see events even on success |
| `timeout_secs` | 180 | Increase for slow convergence scenarios |
| `health_check_readiness = true` | `false` | Wait for nodes to be ready instead of fixed delay |
| `node_locations` | derived from IP | Testing specific ring topologies |
| `tokio_flavor = "current_thread"` | `"current_thread"` | Deterministic scheduling; use `"multi_thread"` for concurrency bugs |

### Event Capture System

The tracing infrastructure captures 9 event categories across all nodes:

| Event Category | What It Tracks |
|---------------|----------------|
| **Connect** | Peer connections, handshake details |
| **Put / Get / Subscribe / Update** | Contract operations with success/failure |
| **Route** | Message routing paths across peers |
| **Lifecycle** | Peer startup/shutdown with uptime |
| **Transfer** | Stream-level data movement |
| **Disconnected** | Connection teardown with duration and byte counts |
| **Timeout** | Transaction expiration |
| **InterestSync** | Delta synchronization failures |
| **TransportSnapshot** | Periodic transport layer metrics |

**Accessing events in tests:**
```rust
// After test execution, aggregate events from all nodes
let aggregator = ctx.aggregate_events().await?;
let events = aggregator.get_all_events().await?;

// Inspect specific transaction flow
let flow = aggregator.transaction_flow(&tx_id).await?;

// Get routing path a transaction took
let path = aggregator.routing_path(&tx_id).await?;

// Export Mermaid diagram of event flow
let diagram = aggregator.mermaid_graph(&tx_id).await?;
```

**Failure reports** are written to `/tmp/freenet-test-*` with:
- Per-peer event timelines
- Event count summaries
- Mermaid sequence diagrams of transaction flow

### RUST_LOG for Targeted Debugging

```bash
# General simulation debugging
RUST_LOG=info cargo test -p freenet --test simulation_integration -- --nocapture --test-threads=1

# Transport-focused
RUST_LOG=freenet::transport=debug,info cargo test ...

# Operations-focused
RUST_LOG=freenet::operations=debug,info cargo test ...

# Ring/routing-focused
RUST_LOG=freenet::ring=debug,info cargo test ...
```

---

## Module: transport/

**What it does:** UDP communication with encryption (X25519 + AES-128-GCM), congestion control (LEDBAT++), NAT traversal, streaming.

### Common Bug Patterns

| Pattern | How to Detect |
|---------|---------------|
| Nonce reuse | Encryption tests — verify counter-based nonces never repeat |
| NAT hole-punch timing | Connection establishment failures in simulation with >2 nodes |
| Packet reordering | Assertion failures in streaming reassembly; UDP has no ordering guarantee |
| Congestion window miscalculation | Throughput tests at various RTTs (10ms, 50ms, 100ms, 200ms) |
| Keep-alive timeout | Unexpected disconnections; check 5-second ping interval, 120s idle timeout |
| Decryption failure handling | Must drop silently + debug log only; never propagate or disconnect |
| `TimeSource` violation | Using `std::time::Instant::now()` instead of trait — breaks simulation determinism |

### Data Collection

| What | How | Access |
|------|-----|--------|
| Connection state transitions | `TransportSnapshot` events in aggregator | Everyone (via `#[freenet_test]`) |
| Encryption round-trip | Unit test with known plaintext/ciphertext | Everyone |
| Congestion window/RTT | `RUST_LOG=freenet::transport=debug` | Everyone |
| NAT traversal sequence | Intro packet events in aggregator | Everyone |
| Packet loss effects | `FaultConfig { message_loss_rate: 0.1, .. }` | Everyone (simulation) |
| Real UDP behavior | Packet capture on test machines | **Limited** |

### Test Approach

```
1. Unit test: Encryption round-trip, tamper detection, wrong key rejection
2. Unit test with SimulationSocket: Connection lifecycle, keep-alive
3. #[freenet_test]: NAT traversal with multiple nodes
4. SimNetwork + FaultConfig: Streaming under packet loss, congestion under latency
5. fdev single-process: Quick multi-peer transport validation
```

**Key rule:** Never use `tokio::net::UdpSocket` directly — always use the `Socket` trait so `SimulationSocket` works in tests.

---

## Module: operations/

**What it does:** State machines for CONNECT, GET, PUT, UPDATE, SUBSCRIBE operations with request-response patterns, timeouts, and sub-operation coordination.

### Common Bug Patterns

| Pattern | How to Detect |
|---------|---------------|
| Push-before-send violation | Race condition where response arrives before operation exists in OpManager |
| Invalid state transition | `InvalidStateTransition` log entries; `(current_state, message)` mismatch |
| Sub-operation race | Parent completes before child; child registers after parent pushes |
| Streaming threshold | Payloads near 64KB boundary; check `should_use_streaming()` |
| Timeout handling | Operations not cleaned up by GarbageCleanup (5-second sweep) |
| Missing `completed()` call | Operation hangs; never sends result to client |

### Data Collection

| What | How | Access |
|------|-----|--------|
| State transitions | Put/Get/Subscribe/Update events in aggregator | Everyone (via `#[freenet_test]`) |
| Transaction parent-child | ULID-based Transaction IDs with parent tracking | Everyone (via logs) |
| Timeout expiration | `Timeout` events in aggregator | Everyone |
| Operation routing path | `aggregator.routing_path(&tx_id)` | Everyone (via `#[freenet_test]`) |
| Mermaid sequence diagram | `aggregator.mermaid_graph(&tx_id)` | Everyone (via `#[freenet_test]`) |
| GarbageCleanup activity | `RUST_LOG=freenet::operations=debug` | Everyone |

### Test Approach

```
1. Unit test: State transition logic — match (state, message) pairs
2. Unit test: Timeout behavior — advance simulation time past deadline
3. #[freenet_test] single gateway: Contract put/get/subscribe lifecycle
4. #[freenet_test] multi-node: Cross-peer operation routing and convergence
5. SimNetwork + FaultConfig: Operations under message loss and latency
```

**Key pattern:** Always `op_manager.push()` before `network_bridge.send()`. Always `expect_and_register_sub_operation()` before pushing child.

**Debugging state machine bugs:**
```rust
// In test, observe the full transaction flow across nodes
let flow = aggregator.transaction_flow(&tx_id).await?;
for event in &flow {
    tracing::info!(peer=%event.peer_id, kind=?event.kind, ts=%event.datetime);
}
```

---

## Module: ring/

**What it does:** DHT topology, peer location assignment, distance calculations, routing decisions, connection management (25 min / 200 max bounds).

### Common Bug Patterns

| Pattern | How to Detect |
|---------|---------------|
| Location hash drift | Contract locations outside [0.0, 1.0] range |
| Connection bound violations | More than 200 or fewer than 25 connections |
| Routing loops | Same peer visited twice; check visited-peer filter |
| Distance calculation error | Non-symmetric distance, incorrect wrap-around at ring boundary |
| Self-connection | Node connecting to itself; must be rejected |
| Incorrect peer selection | `k_closest_potentially_caching()` not filtering transient connections |
| Accept-at-terminus violation | Accepting when closer peers exist instead of forwarding |

### Data Collection

| What | How | Access |
|------|-----|--------|
| Connection counts | `RUST_LOG=freenet::ring=debug` | Everyone |
| Location assignments | `node_locations` parameter in `#[freenet_test]` | Everyone |
| Routing decisions | `Route` events in aggregator | Everyone (via `#[freenet_test]`) |
| Peer selection | Grep for `k_closest` in logs | Everyone |
| Topology convergence | `ctx.aggregate_events()` then inspect Connect events | Everyone |

### Test Approach

```
1. Unit test: Distance calculation — symmetry, wrap-around, boundary values
2. Unit test: Location determinism — same input always produces same location
3. Unit test: Connection bounds — cold-start (0), boundary (25, 200), self-rejection
4. #[freenet_test] with node_locations: Specific topology for routing verification
5. #[freenet_test] multi-node: Visited-peer filtering, accept-at-terminus
```

**Key rule:** Use `PeerKeyLocation` as identifier, never raw `SocketAddr`. Always handle missing location entries — never index directly, use `.get()`.

---

## Module: contract/

**What it does:** WASM sandbox execution (Wasmer) for contracts, state management, delta merges, related contract resolution.

### Common Bug Patterns

| Pattern | How to Detect |
|---------|---------------|
| State merge non-commutativity | Apply deltas A then B vs B then A — results differ |
| State merge non-associativity | (A + B) + C != A + (B + C) |
| Memory limit violation | Contract consumes more than sandbox allows |
| Execution timeout | Contract runs longer than time limit |
| Host memory leak | Host function returns pointer to host memory instead of copying |
| Circular dependency | Contract A depends on B depends on A |
| Invalid state stored | Storing state that fails the contract's own validation |

### Data Collection

| What | How | Access |
|------|-----|--------|
| Contract execution results | Put/Get events in aggregator | Everyone (via `#[freenet_test]`) |
| Validation failures | `RUST_LOG=freenet::contract=debug` | Everyone |
| WASM compilation | `compile_test_contract()` helper in test_utils | Everyone |
| State diffs | Compare states before/after in test assertions | Everyone |
| Execution timeouts | `ContractError::ExecutionError` in logs | Everyone |

### Test Approach

```
1. Unit test: State validation — valid/invalid state inputs
2. Unit test: Merge properties — commutativity and associativity with property-based tests
3. Unit test: Boundary inputs — oversized state, empty state, malformed WASM
4. #[freenet_test] single gateway: Full put/get/update lifecycle
5. #[freenet_test] multi-node: State propagation and convergence across peers
```

**Test data helpers available in `test_utils`:**
- `create_minimal_state()` — smallest valid state
- `create_large_todo_list()` — ~1MB state (streaming threshold testing)
- `create_oversized_todo_list()` — >10MB state (rejection testing)
- `create_max_tasks_todo_list()` — maximum task count

**Key rules:**
- Never trust contract-provided data
- Never execute contracts on the main async runtime
- Never store partial/invalid state
- Limit dependency chain depth; track visited set for circular detection

---

## Fault Injection Reference

`FaultConfig` is available for any simulation test. Use it to reproduce conditions that are hard to hit naturally.

```rust
let fault_config = FaultConfigBuilder::new()
    .message_loss_rate(0.1)           // 10% packet loss
    .latency_range(Duration::from_millis(50)..Duration::from_millis(200))
    .partition(
        Partition::new(set_a, set_b)
            .start_at(Duration::from_secs(10))
            .heal_at(Duration::from_secs(30))
    )
    .node_crash_rate(0.01)            // 1% chance of node crash
    .build();
```

**Verify fault injection actually occurred:**
```rust
let stats = sim.get_network_stats();
// Check that message loss rate matches configured rate
// Check that partitions were active during expected window
```

**Common fault scenarios by module:**

| Module | Fault Scenario | What It Tests |
|--------|---------------|---------------|
| transport | 10% message loss | Retransmission, streaming reassembly |
| transport | 50-200ms latency | Congestion control adaptation |
| operations | Network partition (temporary) | Operation timeout and retry |
| operations | Node crash mid-operation | Sub-operation failure propagation |
| ring | Partition between peer groups | Routing around failures |
| contract | Node crash after put, before propagation | State consistency |
