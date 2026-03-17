# PB-006: Trusted HTTPS Certificate for Remote Access

> Status: Backlog
> Created: 2026-03-05
> Completed: —

## Context

The MCP server supports HTTP/SSE transport for remote access. The current implementation uses either plain HTTP or a self-signed certificate (experimental), neither of which is trusted by MCP clients out of the box.

For remote access from claude.ai or other external MCP clients, a trusted certificate is required.

## Problem

Trusted certificates require proving domain ownership — a trusted CA will not sign a certificate for `localhost` or a bare IP address. This means self-signed certs are the only option without a domain.

## Options

### Option A — Free subdomain + Let's Encrypt (DuckDNS)

1. Register a free subdomain at [duckdns.org](https://www.duckdns.org) (e.g. `yourname.duckdns.org`)
2. Point it at your home/server IP
3. Run Certbot with the DuckDNS plugin to issue a Let's Encrypt certificate
4. Configure `MCP_TLS_CERT` and `MCP_TLS_KEY` to use the issued cert

**Pros:** Fully trusted cert, works with any MCP client, no ongoing cost
**Cons:** Requires a public IP, port forwarding, and certificate renewal (every 90 days, automatable)

### Option B — Tailscale (Recommended for personal use)

Run the MCP server on plain HTTP. Connect to it over a [Tailscale](https://tailscale.com) private network — Tailscale handles encrypted tunneling between your devices transparently.

- Free for personal use (up to 3 users, 100 devices)
- No certificate management
- Nothing exposed to the public internet
- Works across networks (home, office, mobile)

**Pros:** Zero certificate management, private, works without a domain
**Cons:** Both the server machine and the client device must run the Tailscale agent

### Option C — Cloudflare Tunnel

Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose the local HTTP server via a `*.trycloudflare.com` URL with a valid Cloudflare-issued certificate.

- Free tier available
- No domain required, no port forwarding
- Public URL (access-controlled via Cloudflare Access)

**Pros:** Trusted cert, no domain, no port forwarding
**Cons:** Traffic routes through Cloudflare's infrastructure; requires a Cloudflare account for persistent URLs

## Recommendation

For personal single-user access across own devices: **Tailscale** — no certificates, no domains, no exposure.

For access from external MCP clients (e.g. claude.ai): **DuckDNS + Let's Encrypt** — free, fully trusted, automatable renewal.
