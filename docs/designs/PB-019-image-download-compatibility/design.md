# PB-019: Image Download Compatibility — Design

**Status:** Design Approved
**Date:** 2026-04-13
**Feature:** docs/features/active/PB-019-image-download-compatibility.md
**Branch:** `pb-019-image-download-compatibility`

---

## Summary

Fix two root causes that silently drop images from any article hosted behind Cloudflare/WAF or a CDN redirect chain:

1. **Missing browser headers** — `fetchWithTimeout` sends bare `fetch()` requests with no `User-Agent`. Servers protected by Cloudflare, AWS WAF, or hotlink middleware return `403 Forbidden` immediately. Adding a realistic Chrome `User-Agent` and matching `Accept` headers passes bot-detection on virtually all public image hosts.

2. **Redirects unconditionally rejected** — Every 3xx response throws `"Redirect not supported"`. This was a deliberate PB-016 placeholder (`// Don't follow redirects for now - just fail`). Many CDNs serve canonical image URLs that resolve through one or more redirect hops. Implementing safe, per-hop redirect following restores these images.

Both fixes are isolated to `src/infrastructure/converter/image-processor.ts`. No domain layer changes, no new npm dependencies.

---

## Current State

### What breaks today

```
fetchWithTimeout(url):
  fetch(url, { redirect: "manual" })   ← no headers at all
  → 403 if server checks User-Agent    ← root cause 1
  → throws "Redirect not supported"   ← root cause 2 (any 3xx)
```

Evidence: `dl.acm.org` returns `HTTP 403` to both WebFetch requests — same failure mode the image processor hits.

### What stays unchanged

- Per-image timeout (`AbortController`, `IMAGE_FETCH_TIMEOUT_MS`)
- Retry loop (up to 2 retries per image)
- Format detection and AVIF/WebP → JPEG conversion
- Graceful degradation (failed images omitted, not fatal)
- Size limits (per-image and total)

---

## Proposed Architecture

### Request headers constant

A module-level constant applied to every outgoing fetch:

```typescript
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "image/webp,image/avif,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};
```

Applied as `headers: BROWSER_HEADERS` in the `fetch()` call. Easy to update when the Chrome version ages out.

### `validateUrl(url: string): Promise<void>`

New private async method. Called before every fetch — both the initial request and each redirect hop.

```
1. Parse URL with new URL(url)
2. Reject if protocol is not "http:" or "https:"
3. dns.promises.lookup(hostname, { verbatim: false })
4. Reject if resolved address is in any private range (see below)
5. Return (no-op) if all checks pass
```

**Private ranges blocked:**

| Range | Description |
|---|---|
| `127.0.0.0/8` | IPv4 loopback |
| `10.0.0.0/8` | Private class A |
| `172.16.0.0/12` | Private class B |
| `192.168.0.0/16` | Private class C |
| `169.254.0.0/16` | Link-local |
| `::1` | IPv6 loopback |
| `fc00::/7` | IPv6 unique local |
| `fe80::/10` | IPv6 link-local |

IP classification uses Node's built-in `net` module (`net.isIPv4`, `net.isIPv6`) with octet arithmetic — no new packages.

### `fetchWithTimeout` — redirect loop

`fetchWithTimeout` gains a `redirectsFollowed` parameter (default `0`) and becomes recursive on 3xx responses:

```
fetchWithTimeout(url, redirectsFollowed = 0):
  1. await validateUrl(url)             ← SSRF check before every request
  2. fetch(url, {
       headers: BROWSER_HEADERS,
       signal: controller.signal,
       redirect: "manual",
     })
  3. if response is 3xx:
       if redirectsFollowed >= 5 → throw "Too many redirects (> 5)"
       location = response.headers.get("location")
       if !location → throw "Redirect without Location header"
       return fetchWithTimeout(location, redirectsFollowed + 1)
  4. if !response.ok → throw "HTTP {status}"
  5. return Buffer.from(await response.arrayBuffer())
```

The `AbortController` and its `setTimeout` are created once at the top level and the `signal` is passed into every recursive call. The 15s budget covers the entire redirect chain, not each hop independently.

### Data flow after this change

```
downloadAndProcessImage(url):
  fetchWithTimeout(url)
    └─ validateUrl(url)              ← rejects private IPs
    └─ fetch(url, BROWSER_HEADERS)  ← passes WAF/Cloudflare
       ├─ 200 OK → return buffer
       └─ 3xx → fetchWithTimeout(location, depth+1)
                   └─ validateUrl(location)   ← SSRF check on redirect target
                   └─ fetch(location, ...)
                      └─ ...
```

---

## Affected Specs

- **`docs/specs/PB-016-image-downloading-spec.md`** — update or add:
  - FR-1 addendum: requests must include browser-compatible headers
  - New FR covering redirect following: "The system must follow HTTP redirects up to 5 hops"
  - New FR: "Redirect targets that resolve to private/loopback IP addresses must be rejected"
  - NG-2 note: authenticated images remain out of scope; browser headers do not constitute authentication

---

## Testing Strategy

All new tests go in `test/infrastructure/converter/image-processor.test.ts`.

**Header tests:**
- Outgoing request includes `User-Agent` matching `BROWSER_HEADERS`
- Outgoing request includes `Accept` header

**Redirect tests:**
- Image behind 1 redirect downloads successfully
- Image behind 5 redirects (at limit) downloads successfully
- Image behind 6 redirects throws and image is counted as failed (graceful)
- Redirect without `Location` header throws and is counted as failed

**SSRF tests:**
- Initial request URL resolving to `127.0.0.1` is rejected before fetch
- Redirect to `10.0.0.1` is rejected
- Redirect to `192.168.1.1` is rejected
- Redirect to `172.16.0.1` is rejected
- Redirect to `::1` (IPv6 loopback) is rejected
- Redirect to `javascript:` protocol is rejected

**Regression:**
- All existing image-processor tests pass unchanged

---

## Resolved Design Decisions

| # | Decision | Resolution |
|---|---|---|
| DD-1 | User-Agent style | Browser-like Chrome/Windows UA — passes Cloudflare and most WAF bot-detection |
| DD-2 | Redirect following strategy | Manual per-hop (keep `redirect: "manual"`) — SSRF check at every hop, no new dependencies |
| DD-3 | Redirect depth cap | 5 hops — sufficient for all real CDN chains; unlimited depth would allow DoS |
| DD-4 | Timeout scope | AbortController shared across entire redirect chain — total budget is 15s regardless of hop count |
| DD-5 | IP validation tooling | Node built-in `net` module + octet arithmetic — no new dependencies |

---

## Non-Goals

- Configurable `User-Agent` (fixed default is sufficient; can be added later)
- Authenticated or cookie-gated images (NG-2 from PB-016)
- Proxy support
- Changes to timeout values, retry count, or size limits

---

## Known Limitation — Cloudflare Bot Management (TLS Fingerprinting)

The original assumption — "Adding a realistic Chrome User-Agent and matching Accept headers passes bot-detection on virtually all public image hosts" — was confirmed incorrect for dl.acm.org after implementation.

**Root cause:** Cloudflare Bot Management uses **JA3/JA3N TLS fingerprinting**: it compares the declared `User-Agent` (Chrome) against the TLS ClientHello signature generated by the HTTP client (Node.js/OpenSSL). The signatures do not match, so the request is rejected with HTTP 403 regardless of what HTTP headers are present. This was verified by testing with no headers, browser headers, and full `sec-ch-ua` + `Sec-Fetch-*` headers — all returned `HTTP 403` with Cloudflare CF-Ray headers present.

**What PB-019 does fix:** Basic hotlink protection, User-Agent checks, and CDN redirect chains — which covers the majority of public image hosts. The Webflow CDN sample (66 images, 0 failures) confirms this.

**What PB-019 does not fix:** Sites using Cloudflare Bot Management (e.g. dl.acm.org, some academic publishers). These are added as NG-7 in the PB-016 spec.

**Future path:** A `curl --impersonate chrome` subprocess fallback would bypass TLS fingerprinting by using curl's built-in browser impersonation (available in curl 8.x). This is tracked as a separate backlog item.
