# Production Smoke Testing

## The four test tiers of a Freenet dApp

Don't conflate them. Each catches a different failure mode; none of them
catches what the others catch.

| Tier | What it runs | What it catches | What it misses |
|---|---|---|---|
| **rust** | `cargo test --workspace` (incl. `cargo test -p <contract> --features contract` for host-side contract tests) | State logic, commutative-monoid invariants, serialization round-trips, signature verification, validation rules. | Anything involving a live node or the gateway. |
| **offline** | UI build with `--features example-data,no-sync --no-default-features`, served via `dx serve`, driven by Playwright. | UI flows that don't depend on a node: identity creation against mock data, render correctness, navigation, form validation. | Real WebSocket bridge, real contract PUT/GET/UPDATE, real delegate calls, real AFT, gateway behavior. |
| **iso** (isolated multi-node E2E) | Spin up a 2-node Freenet network on `127.0.0.1` (see the `local-dev` skill, isolated test node), publish the webapp, drive the UI via Playwright. | Real round-trip behavior: identity creation persisted to the delegate, contract PUTs landing, AFT burns, cross-node propagation, decrypt-on-receive. Catches the bugs that only appear with a real node. | Production gateway specifics (production has different deployments, NAT, real peer counts). Cost: 5–10 min per run; gate to tags / nightly. |
| **liveness** | `production-liveness.spec.ts` against the **deployed gateway URL** post-release. | Publish-pipeline bugs: corrupted tar.xz, wrong signature, stale `contract-id.txt`, routing misconfig, gateway CSP regression, iframe-shell regression, vendored asset 404s. **Intentionally minimal** — gateway serves webapp, WASM loads, Dioxus mounts, "create new identity" link renders. | Real round-trip. The deployed gateway has no test fixtures and the test runs as a real user with no identity — it can't verify message delivery, AFT, contract migration, or anything past first render. |

**The shape of a healthy release:**

1. `rust` + `offline` gate every PR.
2. `iso` gates release tags (or runs nightly if you have <1 release/week).
3. `liveness` runs immediately post-publish and tells you whether
   anything reached the live gateway at all.
4. To verify a real round-trip in production after a release, run `iso` against
   a fresh node pointed at the published contract ID, or follow a manual
   checklist for your app's core flow. `liveness` does not cover it.

## Validating the UI during development (the `offline` tier)

The liveness spec further down runs post-publish. Do not wait for it to find UI
bugs. The UI you actually ship renders in a browser, and for a Dioxus UI there
is no unit-test path that runs the compiled WASM bundle at all, so browser
automation is the first tier that sees the real thing. It belongs in the
development loop, not the release checklist.

Serve the UI from its dev server and point Playwright straight at it. There is
no gateway and no iframe shell in this tier, so plain `page.locator(...)` works.
Assert that the first screen renders, exercise one real interaction (so a
component that paints but whose handlers are dead is caught), and fail on any
console or page error. This tier catches what no Rust test can: a bundle that
never boots, dead event handlers, and assets that resolve in dev but are missing
from the bundle. Run it on every PR.

- **Wait on rendered content, not on navigation.** `page.goto` resolves once the
  HTML shell loads, well before the WASM bundle has booted. Assert on a visible
  element with a generous timeout.
- **Test the current build.** `dx serve` rebuilds on a delay, so a run started
  too early exercises the previous bundle. In CI, build first and serve the built
  output.

The strict "no console errors" assertion is safe here because there is no gateway
shell to emit the benign wasm-bindgen `onerror` noise described below. Against the
gateway URL it has to become the curated `FATAL_CONSOLE_PATTERNS` allowlist.

## The two production-only pitfalls

Two things break only after publish, not under `dx serve` or `vite dev`: **CSP
blocks remote assets** (`ui-patterns.md` "Gateway CSP"), and **the gateway wraps
every webapp in an iframe shell**, so standard `page.locator(...)` and
`page.goto("/")` find the wrong document and silently pass.

> **Source of truth.** The shell and CSP are emitted by
> `crates/core/src/server/path_handlers.rs`, `path_handlers/assets/shell.html`
> and `client_api.rs` in freenet-core. If a recipe stops working, check those
> first.

## The Gateway Iframe Shell

`GET /v1/contract/web/<id>/` returns a small shell page, not your webapp. Its
inline bridge script assigns `<iframe id="app">`'s `src` from `data-src`
(`.../?__sandbox=1`), and your webapp runs inside that sandboxed frame. The shell
holds the real WebSocket and the auth token and proxies `postMessage`
(`ui-patterns.md` "Two Connection Models").

### Practical Consequences for E2E Tests

Two `page.*` idioms break against the shell:

**1. `page.locator(...)` finds nothing.**

```ts
// ❌ Wrong — operates on the shell document, which contains only <iframe id="app">
await expect(page.locator("h1")).toHaveText("My App");

// ✅ Right — reach into the iframe
const app = page.frameLocator("iframe#app");
await expect(app.locator("h1")).toHaveText("My App");
```

**2. `page.goto("/")` lands on the node dashboard.**

`page.goto(url)` resolves `url` against `playwright.config.ts`'s `baseURL`
using `new URL(url, baseURL)`. If `url` starts with `/`, only the *origin*
of `baseURL` is kept — the `/v1/contract/web/<id>/` path is dropped, so
`page.goto("/")` lands on the node dashboard, not your webapp. The safest
fix is to navigate to the absolute URL directly:

```ts
// ❌ Wrong — drops the /v1/contract/web/<id>/ prefix, hits the dashboard
await page.goto("/");

// ✅ Right — absolute URL, no resolution surprises
await page.goto(process.env.FREENET_BASE_URL!);

// Also works — empty path is resolved against baseURL as-is, preserving
// its path. Relies on Playwright's baseURL resolution staying consistent
// (the absolute-URL form above is more robust).
await page.goto("");
```

## The `production-liveness.spec.ts` Recipe

A short Playwright spec that catches "did publish + gateway integration
produce a usable webapp" regressions without needing identities or contract
state. Runs in a few seconds.

```ts
// e2e/production-liveness.spec.ts
import { test, expect, type ConsoleMessage } from "@playwright/test";

// Set FREENET_BASE_URL to the gateway-hosted webapp URL, e.g.
//   FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/
// The spec is skipped if the URL doesn't look like a contract-web URL,
// so this file is harmless to ship even when CI runs offline.
const BASE_URL = process.env.FREENET_BASE_URL;
const SKIP =
  !BASE_URL || !/\/v1\/contract\/web\//.test(BASE_URL);

// Console errors that should fail the test. Add to this if your app has
// known-benign console errors at startup that you don't want to gate on.
const FATAL_CONSOLE_PATTERNS = [
  /Content Security Policy/i,
  /Refused to (load|apply|execute|connect)/i,
  /Failed to load resource/i,
  /net::ERR_/i,
];

test.describe("production liveness", () => {
  test.skip(SKIP, "FREENET_BASE_URL not set to a /v1/contract/web/... path");

  test("webapp mounts, CSS loads, no fatal console errors", async ({ page }) => {
    const fatalErrors: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (FATAL_CONSOLE_PATTERNS.some((re) => re.test(text))) {
        fatalErrors.push(text);
      }
    });
    page.on("pageerror", (err) => fatalErrors.push(String(err)));
    page.on("requestfailed", (req) =>
      fatalErrors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`),
    );

    // Navigate to the absolute URL so baseURL resolution can't strip the path.
    await page.goto(BASE_URL!);

    // 1. Shell bridge ran and assigned iframe.src. If this fails, the
    //    inline freenetBridge() script didn't execute (CSP on the shell,
    //    auth-token problem, etc.) — separate from "webapp didn't mount".
    await expect(page.locator("iframe#app")).toHaveAttribute(
      "src",
      /__sandbox=1/,
      { timeout: 10_000 },
    );

    // 2. WASM ran: the bundled <h1> mounts inside the iframe.
    const app = page.frameLocator("iframe#app");
    await expect(app.locator("h1")).toBeVisible({ timeout: 15_000 });

    // 3. Vendored CSS loaded. Replace the selector and expected value
    //    below with ones from YOUR vendored stylesheet — the assertion
    //    has to flip iff the CSS loads. Concrete example: Bulma's
    //    `.title.is-1` sets `font-weight: 600` (UA default for h1 is
    //    700), so:
    //      app.locator(".title.is-1").first()
    //        .evaluate(el => getComputedStyle(el).fontWeight)  // → "600"
    //    A bare `h1` + "not 700" won't work if your stylesheet doesn't
    //    touch h1 — pick a selector your CSS definitely styles.
    const fontWeight = await app
      .locator("REPLACE_WITH_YOUR_VENDORED_CLASS")
      .first()
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(fontWeight, "vendored CSS did not load — check CSP / vendor paths")
      .toBe("REPLACE_WITH_EXPECTED_VALUE");

    // 4. No fatal console / network errors during page load.
    expect(
      fatalErrors,
      `fatal console/network errors:\n${fatalErrors.join("\n")}`,
    ).toEqual([]);
  });
});
```

`fatalErrors == []` catches CSP violations, `Refused to ...` blocks,
`net::ERR_` failures, WASM panics and unhandled rejections. The
`FATAL_CONSOLE_PATTERNS` list deliberately ignores generic `console.error` calls
so benign warnings do not flake the test; add a regex for any new category you
want to gate on.

### Known-benign noise: the wasm-bindgen `onerror` shim crash

A dApp loaded inside the gateway iframe will emit a recurring console error
that is **benign** and must not be gated on:

```
wasm-bindgen: imported JS function that was not marked as 'catch' threw an
error: expected a string argument, found undefined
```

Cause: the shell's WebSocket bridge dispatches a bare `new Event('error')`
(no `filename`/`message` fields). wasm-bindgen's generated `onerror` handler
reads `event.filename`, gets `undefined`, and the un-`catch`-marked import
throws. It surfaces during normal operation, not just on a real failure.

This is the reason the smoke test gates on a curated `FATAL_CONSOLE_PATTERNS`
allowlist rather than asserting `consoleErrors === []` — a blanket
"no console errors" assertion will fail against this noise on every run. Do
**not** add a regex for this message to `FATAL_CONSOLE_PATTERNS`.

`FATAL_CONSOLE_PATTERNS` filters only the `console` sink; the `pageerror`
handler records every uncaught exception. This noise surfaces through
`console.error`, so the allowlist covers it. If you ever see it arrive as a
`pageerror`, filter that message there too.

### Wiring It In

- **`playwright.config.ts`** — set `use.baseURL` to the same URL you put in
  `FREENET_BASE_URL` so both halves of the config agree:

  ```ts
  // playwright.config.ts
  import { defineConfig } from "@playwright/test";

  export default defineConfig({
    use: { baseURL: process.env.FREENET_BASE_URL },
    testDir: "./e2e",
  });
  ```

- **Locally**, after `fdev website publish`:
  `FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ npx playwright test e2e/production-liveness.spec.ts`.

- **CI**, sketched as a bash flow:
  ```bash
  freenet local &                                  # boot local node
  fdev website init ci-smoke                       # throwaway key
  fdev website publish ./dist/ --key ci-smoke | tee publish.log
  export FREENET_BASE_URL=$(grep -oE 'http://127\.0\.0\.1:7509/v1/contract/web/[A-Za-z0-9]+/' publish.log | head -1)
  npx playwright test e2e/production-liveness.spec.ts
  ```
  The skip guard makes the spec a no-op when `FREENET_BASE_URL` is unset,
  so the same file is safe to keep in offline CI runs.

- **Release pipeline** — run post-publish against the production gateway.
  A failure here means publish succeeded but the user-visible app is
  broken; treat it as a release blocker.

## Reference

The `freenet/mail` v0.1.0 release cycle hit both the CSP and iframe issues
before adopting this pattern. See:
- [freenet/mail#27](https://github.com/freenet/mail/pull/27) — `frameLocator` + `goto` for the iframe shell
- [freenet/mail#28](https://github.com/freenet/mail/pull/28) — vendor CSS / fonts under the asset directory
