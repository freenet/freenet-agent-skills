---
name: linux-test
description: Run integration tests that require Linux (full loopback range 127.x.x.x) via Docker. Use when a test fails on macOS with "Can't assign requested address" or when the user says "/linux-test".
user_invocable: true
license: LGPL-3.0
---

# Linux Integration Test Runner

## Overview

Some Freenet integration tests require Linux's full loopback range (`127.x.x.x`) and fail on macOS with "Can't assign requested address". This skill runs those tests inside a Docker container using the `docker/test-runner/` infrastructure.

## Arguments

- **Test name only:** `/freenet:linux-test run_delegate_messaging_e2e` — auto-wraps as `cargo test` with `--nocapture`
- **Full cargo args:** `/freenet:linux-test cargo test -p freenet -- test_name` — passed through directly
- **No args:** Show usage help and list known Linux-required tests

## Known Linux-Required Tests

These tests bind multiple loopback addresses and need Linux:

| Test | Package |
|------|---------|
| `run_app_blocked_peers` | `freenet-ping-app` |
| `run_delegate_messaging_e2e` | `freenet-ping-app` |
| `run_app_delegate_wasmtime` | `freenet-ping-app` |
| `edge_case_state_sizes` | `freenet` |
| `error_notification` | `freenet` |
| Tests in `connectivity.rs` | `freenet` |

## Step 1: Parse Arguments

Determine the command to run inside Docker:

- **No arguments provided:** print the Arguments section above and the known-tests table, then stop.
- **Starts with `cargo`:** Use arguments as-is. Append `-- --nocapture` if no `--` separator is present.
- **Just a test name:** Map to the appropriate cargo test command:
  - If the test name matches a known test above, use the correct package.
  - Otherwise, default to: `cargo test -p freenet --test <name> -- --nocapture`
  - For `freenet-ping-app` tests: `cargo test -p freenet-ping-app --test <name> -- --nocapture`

## Step 2: Ensure Docker Image Exists

```bash
# Check if the image exists
docker image inspect freenet-test-runner >/dev/null 2>&1
```

If the image does NOT exist, build it:

```bash
docker build -t freenet-test-runner -f docker/test-runner/Dockerfile .
```

Tell the user: "Building Docker image `freenet-test-runner` (first time only, takes a few minutes)..."

## Step 3: Run the Test

Execute the test using `docker/test-runner/run.sh`:

```bash
docker/test-runner/run.sh <command args>
```

**Important:** Use `run_in_background` for the Bash tool since tests can take several minutes. Set a generous timeout (600000ms / 10 minutes).

## Step 4: Report Results

Report success with the test count and time, or on failure the relevant error output (panic messages, assertion failures, compile errors).

## Notes

- The first run compiles from scratch (10-15 min); later runs use cached builds in Docker volumes. To reset them: `docker volume rm freenet-test-build freenet-test-target freenet-test-cargo`
