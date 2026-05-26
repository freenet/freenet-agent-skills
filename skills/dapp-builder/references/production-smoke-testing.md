# Production Smoke Testing

After you `fdev publish` a webapp, you need a way to know it actually works
end-to-end against the gateway-hosted form — not just in `dx serve` /
`vite dev`. Two things tend to break only at this stage:

1. **CSP blocks remote assets** (see `ui-patterns.md` "Gateway CSP"). Dev
   loads the page from its own origin where the CSP doesn't apply.
2. **The gateway wraps every webapp in an iframe shell.** Standard
   `page.locator(...)` / `page.goto("/")` Playwright idioms find the wrong
   document and silently pass.

This page covers the iframe shell architecture you have to know to write a
smoke test, and a complete `production-liveness.spec.ts` recipe that asserts
the publish + gateway integration actually produced a working app.

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
URL. The shell page exists for two reasons:

- **Origin isolation.** The iframe runs sandboxed with no parent-origin
  access, so a compromised contract can't read other Freenet origins' state.
- **Auth token injection.** The shell holds the node's auth token and
  forwards it to the iframe over `postMessage`, so the webapp itself never
  sees it in URL / cookie / localStorage. See `ui-patterns.md` "Two
  Connection Models" — webapp code inside the shell uses the shell-managed
  WebSocket model.

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

A minimal Playwright spec that catches the entire class of "did publish +
gateway integration produce a usable webapp" regressions without needing any
identities or contract state. Roughly 50 lines and runs in a few seconds.

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

- **`playwright.config.ts`**: set `use.baseURL` to the gateway-hosted URL,
  *with* the trailing `/v1/contract/web/<id>/` path. `page.goto("")` then
  preserves it.
- **Locally**: run after `fdev publish` against your local node:
  `FREENET_BASE_URL=http://127.0.0.1:7509/v1/contract/web/<id>/ npx playwright test e2e/production-liveness.spec.ts`.
- **CI**: keep the skip guard so the spec is a no-op when no `FREENET_BASE_URL`
  is set; gate it behind a separate publish-and-smoke-test job that boots a
  local node, publishes the webapp, and exports the contract key.
- **Release pipeline**: run it post-publish against the production gateway as
  a release-gate. A failure here means the publish succeeded but the
  user-visible app is broken.

## Reference

The `freenet/mail` v0.1.0 release cycle hit both the CSP and iframe issues
before adopting this pattern. See:
- [freenet/mail#27](https://github.com/freenet/mail/pull/27) — `frameLocator` + `page.goto("")` for the iframe shell
- [freenet/mail#28](https://github.com/freenet/mail/pull/28) — vendor CSS / fonts under `ui/public/vendor/`
