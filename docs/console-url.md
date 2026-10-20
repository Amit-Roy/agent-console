# Console URL and Coder boundary

The console URL is `https://console.nefro-dev-coder.duckdns.org/`.
The Coder dashboard remains at `https://nefro-dev-coder.duckdns.org/`.

## Routing and authentication

DuckDNS resolves the existing domain and wildcard to the VPS. Caddy terminates HTTPS
with the existing wildcard certificate. The alias routes every path, including `/api/`,
`/uploads/`, the service worker, and WebSocket upgrades, to Coder at `127.0.0.1:7080`.
It never proxies directly to the workspace's console port.

Coder still owns GitHub SSO, session expiry, owner-only port access, workspace lifecycle,
and the final connection to Agent Console on workspace port 7070. Console data and
credentials stay in the workspace. No Coder access URL, template, database, or workspace
restart is required. The existing Coder login URL may still use its tunnel domain.

Caddy presents the existing app hostname
`7070--main--nefro-dev-ssdnodes--amit-roy.nefro-dev-coder.duckdns.org` in both `Host`
and `X-Forwarded-Host` so Coder resolves the same workspace application. Only the exact
short HTTPS `Origin` is translated to that app origin, preserving same-origin checks
for writes and WebSocket connections. Other origins remain subject to Coder and Console
checks. Do not add the alias to `AGENT_CONSOLE_PUBLIC_HOST` or expose port 7070 publicly.

Coder's login redirect still names the original app host. A temporary 307 redirect on
that host preserves the complete path and query while returning the browser to the
alias. Coder then redeems its encrypted callback parameter and strips it with its own
redirect. Coder's app session cookie covers the shared DuckDNS parent; the short host
receives its own app ticket. Do not log callback query parameters or cookies.

## Failure paths

- An unauthenticated request reaches Coder's login flow, never Console data.
- A stopped or disconnected workspace returns Coder's existing unavailable page.
- An expired app session returns through the same Coder SSO flow.
- A missing Coder upstream fails closed with a proxy error.
- An already-open old tab may need a reload before its WebSocket uses the alias.

PWA installations, browser notification permission, and push subscriptions belong to
an origin. Open the short URL and reinstall the PWA and enable notifications there.
Old bookmarks and deep links redirect; the new origin does not copy local browser data.

## Rollout and rollback

1. Keep port 7070 owner-only. Back up `/opt/coder/https/Caddyfile` on the VPS.
2. Install `docs/console-url.caddy` as `/opt/coder/https/agent-console/console-url.caddy`.
   Import it inside the existing wildcard site, before its general `reverse_proxy`.
   Keep the dashboard site, wildcard TLS, Acode headers, and triage route unchanged.
3. Validate with Caddy under its existing service environment, then reload Caddy.
   The wildcard access logger must redact `coder_application_connect_api_key_35e783`
   as well as the legacy `coder_application_connect_api_key`. Delete `Cookie`,
   `Authorization`, and `Referer` request headers and `Set-Cookie` and `Location`
   response headers from that logger: the canonical redirect can carry the callback
   key in `Location`. Never print the DuckDNS environment file or log login URLs.
4. Verify the acceptance checks below. Set `AGENT_CONSOLE_URL=https://console.nefro-dev-coder.duckdns.org/`
   in the Console environment file so `bin/agent-console url` prints the alias.
5. Roll back by removing only the alias import and reloading Caddy; remove
   `AGENT_CONSOLE_URL`. The temporary redirect is not permanently cached. Existing
   long-host routing, Coder authentication, and workspace data remain available.

## Acceptance checks

Run `node test/console-url.ts` and `CADDY_BIN=/path/to/caddy python3 test/console-url-caddy.py`.
The Caddy integration suite uses isolated loopback servers and the actual snippet.
Run the repository suite with `AGENT_CONSOLE_PAGE=12 npm test`.

Verify with real Coder before rollout is complete:

- Anonymous short-host page/API requests redirect to Coder login without Console data.
- A fresh browser with a Coder session completes the app callback, ends at the short
  origin, loads Console API data, and receives a WebSocket `hello` message.
- A same-origin authenticated POST reaches Console; a foreign origin is rejected.
- An old deep link keeps its path and query and resolves to the alias.
- The Coder dashboard and authenticated workspace list remain available. The configured
  GitHub login option is still present. Do not log out or restart the workspace to test.
- Manifest, service worker, and static assets load at the short origin.

## Source constraints

This mapping uses Coder v2.38's [application callback and cookie handling](https://github.com/coder/coder/blob/v2.38.0/coderd/workspaceapps/proxy.go),
[canonical auth redirect](https://github.com/coder/coder/blob/v2.38.0/coderd/workspaceapps/db.go),
and [forwarded-host handling](https://github.com/coder/coder/blob/v2.38.0/coderd/httpmw/realip.go).
Recheck those contracts when upgrading Coder. Caddy's
[reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) handles
WebSocket upgrades. A future replacement for Coder needs its own authenticated gateway;
DuckDNS supplies DNS, not authentication or an application API.
