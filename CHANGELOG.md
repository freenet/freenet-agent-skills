# Changelog

All notable changes to this project will be documented in this file.

## 1.0.16 (2026-04-29)
- Fixed release skill: documented the new tiered merge_group model
  (freenet/freenet-core#3973). Release merge_group entries now run the FULL
  suite (Unit & Integration, Simulation, NAT Validation) as the pre-publish
  gate. Non-release merge_group entries skip Simulation and NAT Validation
  (covered by PR-level CI). Updated wait timings: 60 min PR-merge wait, ~20-30
  min for the release gate. Replaced the obsolete "skip on release" lesson with
  the corrected understanding (the previous "main CI already validated"
  premise was wrong — main push doesn't run those jobs at all).

## 1.0.15 (2026-04-24)
- Fixed dapp-builder: stale dependency versions across SKILL.md and references
  - `freenet-stdlib` pinned to `0.6.0` (was `0.1` / `0.3.5`) to match current River
  - `freenet-scaffold` / `freenet-scaffold-macro` pinned to `0.2.2` (was `0.1`)
  - `dioxus` pinned to `0.7.3` with `features = ["web"]`
  - Added warning about stdlib version drift and wire-format errors
- Fixed dapp-builder/build-system.md: replaced stale `fdev publish --state ...` example
  with current `fdev -p 7509 publish ... contract --webapp-archive --webapp-metadata`
  form and noted `--code`/`--parameters` argument ordering vs the `contract` subcommand
- Added dapp-builder/contract-patterns.md "Contract WASM Upgrade & State Migration":
  end-to-end playbook for upgrading contract WASM without stranding state
  (authorized-state precondition, backwards-compatible serialization,
  `OptionalUpgrade` pointer, `legacy_contracts.toml` registry, CLI republish)
- Added Phase 1 step to plan contract upgrade from v1 alongside delegate migration
- Clarified two WebSocket connection models in ui-patterns.md: shell-managed
  (inside the gateway iframe, token injected, no manual `Authenticate`) vs raw
  (CLI / dev-server / direct node access, manual `Authenticate` required)
- Includes prior unreleased commit 265a7de: release skill Step 6 now enumerates
  the 12 required platform binaries explicitly (freenet/freenet-core#3825)

## 1.0.14 (2026-04-10)
- Fixed dapp-builder: WebSocket connection documentation was incorrect
  - WebSocket URL must be derived from `window.location`, not hardcoded to `ws://127.0.0.1:7509`
  - Must use path `/v1/contract/command?encodingProtocol=native`
  - Documented sandboxed iframe architecture (shell page postMessage bridge)
  - Added required `getrandom` js feature for wasm32-unknown-unknown
  - Added `freenet-stdlib` `net` feature requirement for WebApi
  - Bug discovered during ghostkey delegate development: hardcoded URL fails in gateway

## 1.0.13 (2026-04-07)
- Fixed release skill: River announcements now use `cargo run -p riverctl` from river repo instead of installed binary
- Installed `riverctl` embeds stale room_contract.wasm causing "missing contract parameters" failures
- Updated Room Owner VK in release skill to current value
- Added incident learning about stale WASM in installed riverctl

## 1.0.12 (2026-03-27)
- Updated systematic-debugging skill: added Phase 1b "When the Bug Is Reported from the Live Network" -- bridge from network telemetry observations to simulation reproduction with concrete translation table
- Added guidance for optional `telemetry-monitor` project-local skill integration
- Reinforced simulation-first philosophy: telemetry constrains the problem space, simulation reproduces it

## 1.0.11 (2026-03-27)
- Updated release skill: added 30-minute soak test step on non-gateway peer (nova local, or SSH peers framework/technic)
- Soak test runs between gateway update and announcements to catch resource leaks, log spam, and protocol regressions
- Skippable for urgent releases

## 1.0.10 (2026-03-26)
- Merged local-node skill content into local-dev: HTTP endpoints, dashboard scraping, WebSocket API protocol details, NodeDiagnostics config, config.toml reference, ring distance formula, fdev query/diagnostics commands

## 1.0.9 (2026-03-26)
- Updated release skill: River smoke test step, tmux tab naming, release.sh enforcement, matrix-commander Markdown fix, merge queue optimization docs
- Updated pr-creation skill: added Claude Rule Review handling
- Fixed phantom fdev commands in dapp-builder skill
- Added issue assignment checks to prevent duplicate work

## 1.0.8 (2026-03-08)
- Added local-dev skill for local node management and dApp iteration (`/freenet:local-dev`)

## 1.0.7 (2026-02-26)
- Added linux-test skill: runs integration tests requiring Linux loopback range via Docker (`/freenet:linux-test`)
- Uses existing `docker/test-runner/` infrastructure for containerized test execution
- Includes known test mapping for macOS-incompatible tests (connectivity, blocked peers, delegate messaging)

## 1.0.6 (2026-02-25)
- Added 5 recurring bug-prevention patterns (from Feb 2025 fix review of 25 bugs) to review agents and skills
- Updated skeptical-reviewer: added Freenet-specific bug patterns section (select! fairness, fire-and-forget, state cleanup, backoff/jitter, deployment)
- Updated testing-reviewer: added test gap checklist for the 5 patterns
- Updated pr-review skill: added 5-pattern checklist to skeptical review step
- Updated pr-creation skill: added bug-prevention patterns section and checklist item
- Based on freenet-core#3271 analysis

## 1.0.5 (2026-02-22)
- Updated release skill: gateways are now updated immediately after cross-compile binaries are available (no 10-min polling delay)
- Removed --deploy-local and --deploy-remote flags (gateway updates are now automatic)
- Added incident learning: version mismatch when users install before gateways update

## 1.0.4 (2026-02-20)
- Updated release skill with universal content from local nova skill: error recovery, rollback, cross-compile binary waiting, incident learnings, common issues
- Removed nova-specific SSH commands from plugin release skill (those stay in local freenet-release skill)

## 1.0.3 (2026-02-20)
- Updated systematic-debugging: added 6 recurring bug patterns to hypothesis phase (silent failures, resource exhaustion, incomplete wiring, TTL races, safe-change regressions, mock divergence)
- Updated pr-creation: CI gap tests must be in same PR, simulation health metrics required not suggested, added wiring completeness and resource invariant sections
- Based on CI gap analysis from freenet-core#3141

## 1.0.2
- Added release skill

## 1.0.1 (2026-02-14)
- Added claude.md for version tracking
- Established version update workflow

## 1.0.0 (Initial Release)
- dapp-builder skill for building Freenet applications
- pr-creation skill for Freenet PR guidelines
- systematic-debugging skill for debugging methodology
- pr-review skill
- Claude Code hooks for cargo fmt and clippy
- Git pre-commit hooks
