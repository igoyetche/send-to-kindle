# PB-019: Image Download Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix image downloads for WAF-protected hosts (missing browser headers) and CDN redirect chains (unconditional redirect rejection) without relaxing SSRF protections.

**Architecture:** All changes isolated to `src/infrastructure/converter/image-processor.ts`. Add a `BROWSER_HEADERS` constant applied to every fetch. Extract a private `doFetch(url, signal, depth)` method to manage the redirect loop with per-hop SSRF validation via a new `validateUrl(url)` method. `fetchWithTimeout` becomes a thin wrapper that manages the `AbortController` lifecycle and delegates to `doFetch`.

**Tech Stack:** Node.js built-ins only — `node:dns/promises` (hostname resolution), `node:net` (IP classification). No new npm packages.

---

## Files

| Action | Path |
|--------|------|
| Modify | `src/infrastructure/converter/image-processor.ts` |
| Modify | `test/infrastructure/converter/image-processor.test.ts` |
| Modify | `docs/specs/PB-016-image-downloading-spec.md` |

---

## Task 1: Add BROWSER_HEADERS and send them on every image fetch

**Files:**
- Modify: `src/infrastructure/converter/image-processor.ts`
- Modify: `test/infrastructure/converter/image-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe("request headers")` block in `test/infrastructure/converter/image-processor.test.ts`. Add `afterEach` at the top of the file (with the other imports) and add this block after the existing `describe("ImageProcessor")` block:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
```

```typescript
describe("request headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends User-Agent and Accept headers on every image request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 403 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    await processor.process(`<img src="https://example.com/photo.png" alt="test">`);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("Mozilla/5.0"),
          Accept: expect.stringContaining("image/"),
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: FAIL — the existing `fetch(url, { signal, redirect: "manual" })` call has no `headers` field, so the `objectContaining({ headers: ... })` assertion fails.

- [ ] **Step 3: Add the BROWSER_HEADERS constant**

In `src/infrastructure/converter/image-processor.ts`, add this after the existing `const CONVERT_FORMATS` line:

```typescript
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "image/webp,image/avif,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};
```

- [ ] **Step 4: Wire BROWSER_HEADERS into the fetch call**

In `fetchWithTimeout`, change:

```typescript
const response = await fetch(url, {
  signal: controller.signal,
  redirect: "manual", // Manually handle redirects for SSRF protection
});
```

to:

```typescript
const response = await fetch(url, {
  headers: BROWSER_HEADERS,
  signal: controller.signal,
  redirect: "manual",
});
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: the new header test passes. All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/converter/image-processor.ts test/infrastructure/converter/image-processor.test.ts
git commit -m "feat: PB-019 send browser-compatible headers on image fetch requests"
```

---

## Task 2: Add validateUrl with protocol and private IP protection

**Files:**
- Modify: `src/infrastructure/converter/image-processor.ts`
- Modify: `test/infrastructure/converter/image-processor.test.ts`

- [ ] **Step 1: Write the failing SSRF tests**

Add a `describe("SSRF protection")` block in `test/infrastructure/converter/image-processor.test.ts` after the `describe("request headers")` block:

```typescript
describe("SSRF protection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks requests to IPv4 loopback (127.0.0.1) before fetching", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="http://127.0.0.1/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.imageDownloadFailure).toHaveBeenCalledWith(
      "http://127.0.0.1/image.png",
      expect.stringContaining("private IP"),
    );
  });

  it("blocks requests to private class A (10.x.x.x)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="http://10.0.0.1/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks requests to private class B (172.16.x.x)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="http://172.16.0.1/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks requests to private class C (192.168.x.x)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="http://192.168.1.1/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks requests to IPv6 loopback (::1)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="http://[::1]/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows requests to public IPs", async () => {
    // 93.184.216.34 is the real IP of example.com — public, non-private
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    await processor.process(
      `<img src="http://93.184.216.34/image.png" alt="test">`,
    );

    // fetch should have been called (validation passed), even though the request 404s
    expect(mockFetch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: all SSRF tests fail — the current code makes a real connection attempt rather than blocking at the IP level.

- [ ] **Step 3: Add dns and net imports to image-processor.ts**

At the top of `src/infrastructure/converter/image-processor.ts`, add after the `import sharp` line:

```typescript
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
```

- [ ] **Step 4: Add the isPrivateIp helper function**

Add this module-level function in `src/infrastructure/converter/image-processor.ts` after the `BROWSER_HEADERS` constant:

```typescript
function isPrivateIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) // 169.254.0.0/16 link-local
    );
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" || // loopback
      lower.startsWith("fc") || // fc00::/7 unique local
      lower.startsWith("fd") || // fc00::/7 unique local
      lower.startsWith("fe80") // fe80::/10 link-local
    );
  }
  return false;
}
```

- [ ] **Step 5: Add the validateUrl private method**

Add this private method to the `ImageProcessor` class (before `fetchWithTimeout`):

```typescript
private async validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Redirect to non-HTTP protocol: ${url}`);
  }

  // URL.hostname for IPv6 literals includes brackets: "[::1]" — strip them
  // before passing to dns.lookup, which expects bare IP strings.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  const { address } = await dnsLookup(hostname, { verbatim: false });
  if (isPrivateIp(address)) {
    throw new Error(
      `Blocked: URL resolves to private IP address (${address})`,
    );
  }
}
```

- [ ] **Step 6: Call validateUrl at the top of fetchWithTimeout**

In `fetchWithTimeout`, add `await this.validateUrl(url);` as the first line inside the `try` block, before the `fetch()` call:

```typescript
private async fetchWithTimeout(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    this.config.fetchTimeoutMs,
  );

  try {
    await this.validateUrl(url);

    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
      redirect: "manual",
    });
    // ... rest unchanged
```

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: all SSRF tests pass. All existing and T-01 header tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/infrastructure/converter/image-processor.ts test/infrastructure/converter/image-processor.test.ts
git commit -m "feat: PB-019 add validateUrl with private IP SSRF protection"
```

---

## Task 3: Refactor fetchWithTimeout and implement redirect following

**Files:**
- Modify: `src/infrastructure/converter/image-processor.ts`
- Modify: `test/infrastructure/converter/image-processor.test.ts`

- [ ] **Step 1: Write the failing redirect tests**

Add a `describe("redirect following")` block in `test/infrastructure/converter/image-processor.test.ts` after the SSRF block. These tests mock `fetch` to return controlled redirect responses. The redirect target uses `example.com` (a public domain) so `validateUrl`'s DNS check passes.

```typescript
describe("redirect following", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A minimal valid 1×1 PNG that sharp can parse
  const MINIMAL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==",
    "base64",
  );

  it("follows a single redirect and downloads the image", async () => {
    // Both URLs use example.com — an ICANN reserved domain that always resolves
    // to a public IP (93.184.216.34), so validateUrl's DNS check passes.
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/redirected.png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(MINIMAL_PNG), { status: 200 }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="https://example.com/image.png" alt="test">`,
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/redirected.png",
      expect.anything(),
    );
    // Image was ultimately downloaded successfully
    expect(result.stats.downloaded).toBe(1);
  });

  it("follows up to 5 redirect hops successfully", async () => {
    // All redirect targets use example.com so validateUrl's DNS check passes on every hop.
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://example.com/hop2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: "https://example.com/hop3" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "https://example.com/hop4" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Location: "https://example.com/hop5" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(MINIMAL_PNG), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="https://example.com/image.png" alt="test">`,
    );

    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(result.stats.downloaded).toBe(1);
  });

  it("fails gracefully when redirect depth exceeds 5 hops", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop3" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop4" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop5" } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/hop6" } }));
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="https://example.com/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockLogger.imageDownloadFailure).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.stringContaining("Too many redirects"),
    );
  });

  it("fails gracefully when redirect has no Location header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 302 }), // no Location header
    );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="https://example.com/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    expect(mockLogger.imageDownloadFailure).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.stringContaining("Location"),
    );
  });

  it("blocks redirect to a private IP", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://192.168.1.1/secret.png" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const mockLogger = createMockLogger();
    const processor = new ImageProcessor(defaultConfig, mockLogger);

    const result = await processor.process(
      `<img src="https://example.com/image.png" alt="test">`,
    );

    expect(result.stats.failed).toBe(1);
    // Only one fetch call — the redirect target was rejected without a second fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockLogger.imageDownloadFailure).toHaveBeenCalledWith(
      "https://example.com/image.png",
      expect.stringContaining("private IP"),
    );
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: all redirect tests fail — the current code throws `"Redirect not supported"` on any 3xx.

- [ ] **Step 3: Refactor fetchWithTimeout — extract doFetch**

Replace the existing `fetchWithTimeout` in `src/infrastructure/converter/image-processor.ts` with two methods:

```typescript
private async fetchWithTimeout(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    this.config.fetchTimeoutMs,
  );

  try {
    return await this.doFetch(url, controller.signal, 0);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Download timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

private async doFetch(
  url: string,
  signal: AbortSignal,
  redirectsFollowed: number,
): Promise<Buffer> {
  await this.validateUrl(url);

  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal,
    redirect: "manual",
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectsFollowed >= 5) {
      throw new Error("Too many redirects (> 5)");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect without Location header");
    }
    return this.doFetch(location, signal, redirectsFollowed + 1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

Note: the `validateUrl` call moves into `doFetch` (removing it from the old position in `fetchWithTimeout`). The `validateUrl` is now called on every hop, including the initial URL and all redirect targets.

- [ ] **Step 4: Run the full test suite**

```bash
npm test -- --reporter=verbose test/infrastructure/converter/image-processor.test.ts
```

Expected: all redirect tests pass. All existing, T-01 header, and T-02 SSRF tests still pass.

- [ ] **Step 5: Run the full suite to check for regressions**

```bash
npm test
```

Expected: all tests pass, zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/converter/image-processor.ts test/infrastructure/converter/image-processor.test.ts
git commit -m "feat: PB-019 implement per-hop redirect following with SSRF protection"
```

---

## Task 4: Update the PB-016 image-downloading spec

**Files:**
- Modify: `docs/specs/PB-016-image-downloading-spec.md`

- [ ] **Step 1: Add new functional requirements**

In `docs/specs/PB-016-image-downloading-spec.md`, append the following to the **Functional Requirements** section (after FR-12):

```markdown
### Request Compatibility

- **FR-13**: Image download requests must include browser-compatible HTTP headers (`User-Agent`, `Accept`, `Accept-Language`) so that WAF-protected and hotlink-protected image hosts serve the asset rather than returning `403 Forbidden`
- **FR-14**: The system must follow HTTP redirects (status codes 301, 302, 303, 307, 308) up to a maximum of 5 hops per image; exceeding this limit fails that image gracefully without halting conversion
- **FR-15**: Before following any redirect, the redirect target URL must be validated: the hostname must resolve to a public IP address; redirects to private or loopback IP ranges (RFC 1918, link-local, IPv6 loopback) must be rejected to prevent SSRF attacks
- **FR-16**: The existing per-image timeout budget covers the entire redirect chain — not each hop independently
```

- [ ] **Step 2: Update NG-2 to clarify browser headers are not authentication**

Find the line:

```markdown
- NG-2: No support for authenticated or paywalled image URLs (images behind login are out of scope)
```

Replace it with:

```markdown
- NG-2: No support for authenticated or paywalled image URLs (images behind login are out of scope). Browser-compatible request headers (FR-13) pass bot-detection and hotlink protection but do not constitute authentication — login-gated images remain out of scope.
```

- [ ] **Step 3: Add the spec update marker**

At the top of the spec file, below the title, add:

```markdown
> Updated 2026-04-13 via feature: PB-019 image download compatibility
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/PB-016-image-downloading-spec.md
git commit -m "docs: PB-019 update PB-016 spec with FR-13 through FR-16 (headers + redirect following)"
```

---

## Dependency Order

```
T-01 (headers) → T-02 (validateUrl) → T-03 (redirect following)
T-03 → T-04 (spec update — describes the finished system)
```
