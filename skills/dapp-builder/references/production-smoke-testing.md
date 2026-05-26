# Production Smoke Testing

Two things break only after `fdev publish`, not in `dx serve` / `vite dev`:

1. **CSP blocks remote assets** (see `ui-patterns.md` "Gateway CSP"). Dev
   loads the page from its own origin where the CSP doesn't apply.
2. **The gateway wraps every webapp in an iframe shell.** Standard
   `page.locator(...)` / `page.goto("/")` Playwright idioms find the wrong
   document and silently pass.

This page covers the iframe shell architecture and a
`production-liveness.spec.ts` recipe that asserts the publish + gateway
integration actually produced a working app.

> **Source of truth.** The CSP and shell HTML described below are emitted
> by `freenet-core/crates/core/src/server/{client_api.rs,path_handlers.rs}`.
> If a smoke-test recipe stops working, verify the wire shape against
> those files first — they're the canonical reference.

## The Gateway Iframe Shell

`GET /v1/contract/web/<id>/` does NOT return your webapp directly. It returns
a tiny shell HTML, roughly (simplified — see `path_handlers.rs` for the
exact attribute set):

```html
<!DOCTYPE html>
<html>
<body>
  <iframe id="app"
          sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"
          allow="clipboard-read; clipboard-write"
          data-src="/v1/contract/web/<id>/?__sandbox=1"></iframe>
  <script>
    // Shell page owns the real WebSocket, holds the auth token, and
    // proxies postMessage from the iframe.
    function freenetBridge(authToken) { ... }
  </script>
  <script>freenetBridge("<auth_token>");</script>
</body>
</html>
```

The second `<script>` tag invokes `freenetBridge` with the auth token; that
call is what assigns `iframe.src` from `data-src` and actually starts your
webapp loading. Your webapp then runs inside `<iframe id="app">` at the
`?__sandbox=1` URL. The shell exists for origin isolation (sandboxed
iframe, no parent-origin access) and auth token injection (the shell holds
the token and forwards it via `postMessage`, so the webapp never sees it
directly). See `ui-patterns.md` "Two Connection Models" for the WebSocket
implications.

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

### What Each Assertion Catches

| Assertion | Catches |
|-----------|---------|
| `iframe#app[src=...__sandbox=1]` | Shell bridge `<script>` ran and wired the iframe |
| `app.locator("h1")` visible | Publish pipeline produced a usable archive; WASM ran |
| `fontWeight` matches your vendored value | Vendored CSS reached the iframe (CSP didn't block it) |
| `fatalErrors == []` | CSP violations, `Refused to ...` blocks, `net::ERR_` failures, WASM panics, unhandled rejections |

The `FATAL_CONSOLE_PATTERNS` list deliberately ignores generic
`console.error` calls so benign warnings don't flake the test. If your app
has a known-benign error at startup, it stays out of the fatal list by
default; if a new error category appears that you want to gate on, add a
regex.

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

- **Locally**, after `fdev publish`:
  `FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ npx playwright test e2e/production-liveness.spec.ts`.

- **CI**, sketched as a bash flow:
  ```bash
  freenet local &                                 # boot local node
  fdev -p 7509 publish ... | tee publish.log      # publish webapp
  KEY=$(grep -oE '[A-Za-z0-9]{40,}' publish.log)  # extract contract key
  export FREENET_BASE_URL="http://127.0.0.1:7509/v1/contract/web/$KEY/"
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
