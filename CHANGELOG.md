# Changelog

All notable changes to this project will be documented in this file.

## 1.5.2 (2026-06-21)

Finish absorbing the freenet-email v0.1.x publish/debug lessons (issue #23).
Patterns 1, 3, and 4 from that issue landed earlier (PRs #34/#35/#36); this
fills the two remaining "pattern 2" gaps:

- `local-dev`: documented the `WS_API_PORT` environment variable for
  targeting a non-default node when publishing through a `cargo-make`
  `publish-*` task (which has no `--port` flag). Notes the unhelpful
  `put failed after 4 attempts` failure mode of a misdirected cargo-make
  publish.
- `dapp-builder` (`references/production-smoke-testing.md`): documented the
  wasm-bindgen `onerror` shim crash (`imported JS function that was not
  marked as 'catch' threw an error: expected a string argument, found
  undefined`) as known-benign console noise from the gateway WebSocket
  bridge. Explains why the smoke test gates on a curated
  `FATAL_CONSOLE_PATTERNS` allowlist instead of asserting
  `consoleErrors === []`, and to leave this message out of the fatal list.

## 1.5.1 (2026-06-09)

- `pr-review`: Step 3 now specifies a fallback when external models are
  unavailable. If `codex` fails, try `gemini`; if both are down (quota /
  capacity / outage), the review no longer fails — it substitutes a
  diverse-Claude-lens pass (at least three independent adversarial lenses,
  per `~/.claude/rules/multi-model-review.md`) and records the substitution
  in the posted review. Previously the skill described only the external pass
  with no documented behavior when it could not run. Also: prefer waiting for
  the external model when the change isn't time-sensitive and the quota reset
  is near, and run the lenses serially within your own context when you can't
  spawn subagents (background / dispatched agents without the Agent/Task tool).

## 1.5.0 (2026-06-05)

- `dapp-builder`: added `references/upgrade-and-migration.md` — the operational
  discipline for upgrading contracts and delegates without losing user data,
  distilled from River's production incidents (freenet/river#345 per-entity CAS
  keys, #352 resumable/interrupted-migration recovery, #253 regression-gated
  legacy probe). Covers the five properties of a safe migration (idempotent,
  resumable, non-destructive, regression-gated, observable), sharding mutable
  storage by unit-of-concurrent-change with compare-and-swap instead of blind
  overwrite, enumerating dynamic key families, coupled-artifact lockstep, the
  upgrade test harness (old-state -> new-code plus interrupted-migration
  recovery), and staged reversible rollout. Linked from SKILL.md Phase 1/2
  migration steps and Phase 4.

## 1.3.0 (2026-05-28)

Sync Freenet-specific dApp practices proven out in freenet/mail through
May 2026 (issues #198, #199, #200, #206, #213, #251). Generic engineering
practices (CI runner sizing, version-drift guards, pre-commit hooks, QA
matrices, upstream-bug quarantine) deliberately left out of this version
— they belong in a separate non-Freenet skill set.

- `local-dev`: documented the **isolated multi-node harness pattern** —
  `--config-dir` per node (NOT `--data-dir`) is what isolates
  `config.toml` and transport keypairs across two `freenet` instances on
  one host. On CI runners with `XDG_CONFIG_HOME` set, a `HOME=…`
  override is bypassed and only `--config-dir` works.
- `dapp-builder/build-system.md`: documented **per-contract lockfile
  isolation** (`[workspace.exclude]` + own `Cargo.lock` + `=x.y.z` pins
  + `CARGO_TARGET_DIR=<crate>/target` on every `fdev build`). Without
  this pattern, a workspace dep bump silently rotates contract WASM
  bytes and IDs, orphaning every user's stored state. Also documents
  the **contract-ID reproducibility caveat**: signed-payload version is
  a unix timestamp at signing time → contract IDs are NOT reproducible
  from source, the committed `contract-id.txt` / `facade-id.txt` are
  authoritative.
- `dapp-builder/references/contract-patterns.md`: documented the
  **chained-migration recipe** — append-only `LEGACY_*_CODE_HASHES`
  walked oldest→newest on UI startup when an identity's recorded WASM
  hash drifts from current; `pending_migration_from` on the delegate
  for cross-session retry; recipient WASM hash captured at contact
  import so upgraded senders can deliver to non-upgraded recipients;
  the `current_hash_not_in_legacy` test invariant.
- `local-dev`: documented installing `fdev` / `freenet` from the
  freenet-core release tag's prebuilt `.tar.gz` rather than
  `cargo install` — same binary CI uses, ~5s vs 10–15 min, and pins
  you to a known fdev API surface (matters for the `--as-state` flag
  used by facade pointer flips).
- `dapp-builder/build-system.md`: documented the **pre-commit hook for
  signed-and-committed publishing** — block stray `.wasm` outside
  `published-contract/`, require `contract-id.txt` co-staged alongside
  any WASM change. Without it, build artifacts leak into commits and
  snapshot drift goes unnoticed.
- `dapp-builder/references/production-smoke-testing.md`: documented the
  **four Freenet dApp test tiers** (offline / iso / liveness / rust),
  what each catches and what each misses, so a project doesn't ship
  thinking a liveness smoke covers real round-trip behavior.
- `systematic-debugging`: documented **structured-field log assertions**
  in E2E — modern freenet-core (0.2.6x) emits tracing fields like
  `phase="update_complete"` and `phase="relay_started"`. Asserting on
  legacy wire-level markers (`UPDATE_PROPAGATION`) gives silent false
  positives. Also: quarantine upstream bugs with `skip-with-reason`,
  do not remove the test.
- **NEW** `dapp-builder/references/facade-pattern.md`: full **stable-URL
  facade contract architecture** — facade WASM (never rebuilt per
  release) + facade-types crate + `FacadePointer { version,
  current_app_id, prev_app_ids }` state + `fdev execute update
  --as-state` (default `UpdateData::Delta` is silently rejected) +
  `postMessage`-to-parent loader (gateway's `X-Frame-Options: DENY`
  blocks same-window redirects from inside the sandbox iframe) +
  webapp-cache busting after pointer flips + CI byte-equality check
  with non-linux/amd64 bootstrap flow.

## 1.2.3 (2026-05-26)
- `dapp-builder`: documented the gateway CSP, iframe shell, and post-publish
  smoke testing — three "only show up in production" pitfalls every Freenet
  webapp hits (issue #22, distilled from freenet/mail v0.1.0).
  - **Vendor your assets.** New "Gateway CSP: Vendor Your Assets" section in
    `ui-patterns.md` explains the same-origin CSP (both `default-src` and
    `connect-src`), why CDN `<link>` / `<script>` tags and cross-origin
    `fetch` calls work in `dx serve` / `vite dev` but fail under
    `fdev publish`, and the right way to bundle stylesheets / fonts under
    `ui/assets/vendor/` (Dioxus `asset_dir` convention, matching River).
    Cross-linked from SKILL.md Phase 3.
  - **Iframe shell + Playwright recipe.** New
    `references/production-smoke-testing.md` documents the
    `<iframe id="app">` shell architecture (with a "source of truth"
    pointer to `freenet-core/crates/core/src/server/{client_api,path_handlers}.rs`)
    and the two Playwright idioms it breaks (`page.locator(...)` finds
    only the shell; `page.goto("/")` lands on the dashboard). Includes a
    `production-liveness.spec.ts` template that:
    - waits for the shell bridge to assign `iframe#app[src]`,
    - asserts the bundled `<h1>` mounts inside the iframe,
    - asserts vendored CSS loaded via `getComputedStyle(...).fontWeight`
      (more stable than `fontSize`, matching the proven
      freenet/mail#28 assertion),
    - filters console errors via `FATAL_CONSOLE_PATTERNS` (CSP /
      `Refused to ...` / `net::ERR_`) so benign warnings don't flake.
    Also includes a `playwright.config.ts` snippet and a CI bash sketch
    that boots a local node, publishes, and exports `FREENET_BASE_URL`.
    Cross-linked from SKILL.md Phase 4 and from `ui-patterns.md`'s "Two
    Connection Models" section.
  - **Tooling preflight.** New section in `build-system.md` noting that
    the gateway port is `7509` (older docs reference the legacy `50509`)
    and offering optional `gnu-tar --sort=name --mtime=@0 --owner=0
    --group=0 --numeric-owner` flags for byte-reproducible webapp archives
    across macOS/Linux build hosts (recommended, not required —
    `fdev publish` itself uses the Rust `tar` crate).

## 1.2.2 (2026-05-26)
- `local-dev` skill: document two silent isolation gotchas that bit users
  during freenet-email E2E debugging (issue #24).
  - **`--data-dir` does not isolate the gateway bootstrap list.** `freenet`
    reads `gateways.toml` from the global config dir (`~/Library/Application
    Support/The-Freenet-Project-Inc.Freenet/` on macOS, `~/.config/freenet/`
    on Linux) regardless of `--data-dir`. On a machine with an existing
    Freenet install, a "local" test node silently dials public gateways and
    joins the live network. New subsection documents the `HOME` override
    workaround and a log-grep verification step.
  - **`fdev` defaults to port 7509.** Without `--port`, `fdev publish`
    silently targets whichever node owns 7509 — typically the system
    service, not the test node. Surface symptom: `"Signature verification
    failed"` on a fresh publish. New callout warns about this and the
    common-issues table now lists both new symptoms.
  - Replaces the misleading "Each node is fully isolated" claim with a
    pointer to the new pitfalls section.

## 1.2.1 (2026-05-25)
- `release` skill rewritten to use `gh workflow run release.yml --field
  version=X.Y.Z` instead of the legacy `./scripts/release.sh` invocation.
  AGENTS.md in freenet-core already documented the workflow as the canonical
  path; the skill had drifted out of date and was telling agents to run the
  script locally (which bails on the "must be on main" branch check from any
  worktree). New flow: trigger workflow → `gh run watch` → verify cascade
  (gateway-update.yml + release-announce.yml fire on `release.published`) →
  River smoke test → post-release health check. Net effect: skill shrunk
  from 312 to ~145 lines and now matches what the pipeline actually does.

## 1.4.0 (2026-05-28)

Stacked on top of 1.3.0 (mail-practices sync). Aligns `dapp-builder` +
`local-dev` with freenet-stdlib v0.8.0 (Rust) and
`@freenetorg/freenet-stdlib` v0.2.0 (TypeScript). Pre-existing 0.6.0
pins were two releases behind; this catches up and documents the deltas
in between. Bumped the inbox-contract lockfile-isolation example added
in 1.3.0 from `=0.6.0` to `=0.8.0` to match.
- `dapp-builder/SKILL.md`:
  - Added **TypeScript + Vite** as a first-class UI option (Phase 3 / Option B) alongside Dioxus, including a parallel project structure template and an npm/Vite dependency table.
  - Bumped Rust `freenet-stdlib` pins from `"0.6.0"` to `"0.8"` (workspace + UI crate); added TypeScript pin `"@freenetorg/freenet-stdlib": "^0.2.0"`.
  - Added security note about stdlib v0.6.0 removal of public `DEFAULT_CIPHER`/`DEFAULT_NONCE` constants (PR #75) — delegates must now generate random cipher/nonce per session.
- `dapp-builder/references/ui-patterns.md`:
  - New TypeScript + Vite section covering the FlatBuffers serialization model, contract/delegate hash injection at build time, and the dynamic-import pattern for internal `-T` types.
  - Bumped Cargo.toml stdlib pin to `"0.8"`.
  - Completed the `ResponseHandler` example with v0.2.0 callbacks `onContractNotFound`, `onSubscribeResponse`, `onClose`.
  - Converted `api.get/put/update/subscribe` examples to the **promise-based API** (`await api.X(...)` + try/catch). Noted that callbacks still fire alongside promises for backward compatibility and that the default request timeout is 30 s.
  - New section "Large state handling (streaming)" covers `CHUNK_THRESHOLD = 512 KB`, `CHUNK_SIZE = 256 KB`, `ReassemblyBuffer`, and the v0.2.0 concurrency limits.
  - Added warning above the `(api as any).sendRequest(...)` cast — internal SDK method, may break on any minor SDK bump; track stdlib for a public delegate-message builder.
- `dapp-builder/references/delegate-patterns.md`:
  - Renamed `attested: Option<&'static [u8]>` parameter to `origin: Option<MessageOrigin>` in `DelegateInterface::process()` examples (stdlib v0.5 breaking change).
  - New section "Inter-delegate messaging" covering `MessageOrigin::WebApp(ContractInstanceId)` vs `MessageOrigin::Delegate(DelegateKey)` (PR #65), with a whitelist-based authorization pattern and the note that an inter-delegate message replaces (not composes with) any inherited `WebApp` origin.
  - Added wildcard `_ => {}` arms to all `InboundDelegateMsg` matches with comments noting the `#[non_exhaustive]` requirement from stdlib v0.6.0 (PR #66).
  - Added API drift note flagging that the pre-v0.5 secrets-by-message pattern is now `DelegateCtx::get_secret/set_secret` synchronously.
- `dapp-builder/references/build-system.md`:
  - Added TypeScript + Vite plain-`Makefile` block alongside the Rust + cargo-make flow; documented that River uses cargo-make and freenet-microblogging uses plain Make + Vite.
  - **`fdev publish` differs for contracts vs delegates.** Contracts take raw `target/wasm32-unknown-unknown/release/*.wasm`; delegates take the packaged file from `build/freenet/` produced by `fdev build --package-type delegate`. Wrong file type → silent failure or cryptic errors.
  - Documented the ANSI-strip pattern when piping `fdev` output (`sed 's/\x1b\[[0-9;]*m//g'`) and the `clean-node` pattern for republishing under the same key during dev.
  - Bumped Rust workspace stdlib pin from `"0.6.0"` to `"0.8"`; bumped the inbox-contract lockfile-isolation example added in 1.3.0 to `=0.8.0` to match.
- `local-dev/SKILL.md`:
  - Renamed "seeding contracts" → "hosting contracts" in `NodeDiagnosticsConfig` comment to match the stdlib terminology rename (PR #64).
  - Added wire-format note: `NodeDiagnosticsResponse.contract_states` is now `HashMap<String, ContractState>` with Base58-encoded keys (PR #70, v0.7.0 bidirectional bincode break).

## 1.2.0 (2026-05-21)
- Added `dapp-builder` reference `identity-and-addressing.md`: how to give users a
  short, stable, shareable identifier without leaking raw key material or coupling
  identity to a contract's WASM version.
  - **Self-certifying short identifiers.** Make the user-facing "address" a short
    hash of the public key; keep the full key in contract state (not parameters)
    and have `validate_state` verify the key hashes to the address.
  - **Crypto key sizing.** Elliptic-curve keys are 32 bytes; post-quantum public
    keys (ML-DSA, ML-KEM) run to kilobytes and need a separate key per operation —
    keep large key material out of identifiers and parameters.
  - **Address truncation is a security parameter.** Guidance on choosing the hash
    truncation length for second-preimage resistance (16 bytes / 128-bit default).
  - **Identity must not be a contract key.** A user's stable handle has to be
    key-derived so it survives WASM upgrades; migration moves state across
    contract keys while the address stays fixed.
- `contract-patterns.md`: "Contract Parameters" now warns against embedding large
  keys in parameters; the migration section notes identity must be key-derived.
  Cross-references added from `SKILL.md` Phase 1 and the skill README.

## 1.1.0 (2026-05-20)
- Reworked `pr-review` to match current Claude Code capabilities and PR-review
  best practices:
  - **Risk-tiered review.** The skill triages each PR to Skip / Light / Full and
    scales the reviewer set to match — trivial changes are not put through the full
    multi-model treatment; high-risk surfaces (concurrency, crypto, migrations, wire
    format, transport, contract/delegate WASM) always get the full review.
  - **Parallel subagents are now the default path**, not an optional addendum.
    The skill orchestrates the four reviewers concurrently rather than walking
    one agent through six perspectives by hand.
  - **Invokes the reviewers as first-class subagents** (`freenet:code-first-reviewer`,
    `freenet:testing-reviewer`, `freenet:skeptical-reviewer`,
    `freenet:big-picture-reviewer`) via the `Agent` tool's `subagent_type` with
    `run_in_background: true`. Removed the obsolete "spawn `general-purpose` and
    paste the agent definition into the prompt" instructions.
  - **Reviews from a dedicated worktree** of the PR's code, so reviewers `Read`/`Grep`
    the PR's actual code (not `main`'s) without disturbing the user's working tree —
    avoids `gh pr checkout` clobbering uncommitted work. Added checkout-awareness
    notes to all four agent definitions.
  - **Fetches existing PR review comments** up front (issue-level and inline) so
    the review addresses prior feedback instead of duplicating it.
  - **Added a synthesis step**: deduplicate overlapping findings, reconcile
    reviewer disagreements, and verify every cited `file:line` before reporting.
  - **Posts the consolidated review to the PR** via `gh pr review --comment`.
  - Replaced the vague "ask Codex" instruction with a concrete external-model pass
    (`codex review`), optionally wrapped by a `codex-review` / `gemini-cli-review`
    skill when the environment provides one.
  - De-staled the Freenet bug-pattern guidance: SKILL.md and the skeptical/testing
    agents now point at the canonical, continuously-updated
    `.claude/rules/bug-prevention-patterns.md` in freenet-core and no longer claim
    the frozen Feb-2025 snapshot of five patterns is complete.
  - Added large-diff (file-batching) guidance and a mandatory worktree-cleanup step.

## 1.0.19 (2026-05-06)
- Reordered concepts in `dapp-builder/SKILL.md`: the "Core Concept: The
  Contract is the Key" section used to come before the components were
  introduced, so it forward-referenced "the WASM that controls the data"
  and the table-row analogy. Moved the key-derivation explanation below
  "The Three Kinds of Components" and renamed it "How Contract Keys Work
  (and Why Freenet is Trustless)" so the reader knows what a contract is
  before reading how its key is formed. Trimmed the contracts-section
  bullet to defer the addressing mechanism to the new section.

## 1.0.18 (2026-05-06)
- Clarified `dapp-builder/SKILL.md` to make explicit that a Freenet app can
  have multiple contracts and multiple delegates (the previous "The Contract"
  / "The Delegate" framing implied exactly one of each). Reframed the
  contract analogy from "Backend or Database" to a database **table**: the
  WASM is the schema, and each parametrized instance is a row with its own
  key and state. Updated Phase 1 / Phase 2 wording and the project-structure
  template to reflect the per-concern split.

## 1.0.17 (2026-05-06)
- Fixed install instructions in `README.md` and `skills/dapp-builder/README.md`:
  the marketplace exposes a single bundled plugin named `freenet`, but the
  READMEs told users to run `/plugin install freenet-dapp-builder` and
  `/plugin install freenet-core-dev` (neither exists). Replaced with the
  correct `/plugin install freenet@freenet-agent-skills` form.

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
