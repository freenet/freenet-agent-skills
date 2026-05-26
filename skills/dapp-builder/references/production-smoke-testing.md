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

## The Gateway Iframe Shell

`GET /v1/contract/web/<id>/` does NOT return your webapp directly. It returns
a tiny shell HTML that looks like:

```html
<!DOCTYPE html>
<html>
<body>
  <iframe id="app"
          sandbox="allow-scripts allow-forms allow-popups"
          data-src="/v1/contract/web/<id>/?__sandbox=1"></iframe>
  <script>
    // freenetBridge(authToken) — shell page owns the real WebSocket,
    // injects the auth token, and proxies postMessage from the iframe.
    function freenetBridge(authToken) { ... }
  </script>
</body>
</html>
```

Your actual webapp loads inside the `<iframe id="app">` at the `?__sandbox=1`
URL. The shell exists for origin isolation (sandboxed iframe, no
parent-origin access) and auth token injection (the shell holds the token
and forwards it via `postMessage`, so the webapp never sees it directly).
See `ui-patterns.md` "Two Connection Models".

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

`page.goto(url)` resolves `url` against the *origin* of `playwright.config.ts`'s
`baseURL`, ignoring its path. So if `baseURL` is
`http://127.0.0.1:7509/v1/contract/web/<id>/`, then `page.goto("/")` resolves
to `http://127.0.0.1:7509/` — the node's dashboard, not your webapp.

Pass an empty path so the full baseURL is preserved, or pass an absolute URL:

```ts
// ❌ Wrong — drops the /v1/contract/web/<id>/ prefix, hits the dashboard
await page.goto("/");

// ✅ Right — preserves the full baseURL path
await page.goto("");

// ✅ Also right — absolute URL
await page.goto(process.env.FREENET_BASE_URL!);
```

## The `production-liveness.spec.ts` Recipe

A ~50-line Playwright spec that catches "did publish + gateway integration
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

test.describe("production liveness", () => {
  test.skip(SKIP, "FREENET_BASE_URL not set to a /v1/contract/web/... path");

  test("webapp mounts, CSS loads, no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(String(err)));

    // page.goto("") preserves the full BASE_URL path through the shell.
    await page.goto("");

    // Reach into the iframe shell. The app mounts at iframe#app.
    const app = page.frameLocator("iframe#app");

    // 1. WASM ran: the bundled <h1> is present.
    await expect(app.locator("h1")).toBeVisible({ timeout: 15_000 });

    // 2. Vendored CSS loaded: a known class produces the expected
    //    computed style. This catches the CSP-blocked-CDN regression.
    //    Replace ".title.is-1" / "font-size" / "48px" with values that
    //    match a class from your vendored stylesheet.
    const fontSize = await app
      .locator(".title.is-1")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontSize).toBe("48px");

    // 3. No console errors. Catches CSP blocks, missing assets, WASM
    //    panics, and unhandled promise rejections.
    expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
```

### What Each Assertion Catches

| Assertion | Catches |
|-----------|---------|
| `app.locator("h1")` visible | Publish pipeline produced a usable archive; WASM ran; `?__sandbox=1` route works |
| `getComputedStyle(...)` matches | Vendored CSS reached the iframe (CSP didn't block it) |
| `errors == []` | CSP violations, missing assets, WASM panics, unhandled promise rejections |

### Wiring It In

- **`playwright.config.ts`**: set `use.baseURL` to the full gateway URL
  including the `/v1/contract/web/<id>/` path so `page.goto("")` preserves it.
- **Locally**, after `fdev publish`:
  `FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ npx playwright test e2e/production-liveness.spec.ts`.
- **CI**: the skip guard makes the spec a no-op when `FREENET_BASE_URL` is
  unset; gate it behind a job that boots a local node, publishes the webapp,
  and exports the contract key.
- **Release pipeline**: run post-publish against the production gateway. A
  failure here means publish succeeded but the user-visible app is broken.

## Reference

The `freenet/mail` v0.1.0 release cycle hit both the CSP and iframe issues
before adopting this pattern. See:
- [freenet/mail#27](https://github.com/freenet/mail/pull/27) — `frameLocator` + `page.goto("")` for the iframe shell
- [freenet/mail#28](https://github.com/freenet/mail/pull/28) — vendor CSS / fonts under `ui/public/vendor/`
