# DOX-U Analytics

DOX-U is a small self-hosted analytics collector written in Rust. Add its JavaScript file to a site to record a visit, collect browser-side details, and submit custom events. The collector joins each browser report and event to the server-side data captured for that script request.

## How collection works

1. The visitor's browser requests `/script.js`. The server records a visit in SQLite with the request IP, peer IP, user-agent/client hints, language headers, origin, and referrer. It returns the JavaScript with an opaque visit ID and the captured server data.
2. The script collects browser details and posts them to `/api/collect`. This includes screen and viewport information, timezone, language, browser hints, selected device capabilities, and best-effort WebRTC addresses. It also records the current page URL, title, and referrer.
3. The script checks public IP addresses with `ipwho.is` from the visitor's browser and stores those responses with the visit. The collector server itself does not call the geolocation service.
4. Site code can call `window.doxU.track(name, properties)` to save custom events. Each event has a foreign key to its visit, so querying the event and visit records together provides the event plus the server-side request data and any browser report.

The browser report is sent after the script runs, so it may be missing when JavaScript is disabled, blocked, or interrupted. The server-side visit is written when `/script.js` is requested.

## Run the server

Requirements: a Rust toolchain with Cargo.

```sh
cargo run --release
```

By default the server listens on `0.0.0.0:3000`, stores data in `data/dox-u.sqlite3`, and serves the interactive overview at `/` and saved visits at `/visits`. The visits dashboard displays up to 50 records per page.

Configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `DATABASE_PATH` | `data/dox-u.sqlite3` | SQLite database file path. Use `:memory:` for a temporary in-memory database. |
| `DOX_MODE` | unset | Set to `collector` to make `/` a minimal page that loads the collector script. |
| `TRUSTED_PROXY_IPS` | empty | Comma-separated IP addresses of trusted reverse proxies. Forwarded client IP headers are ignored unless the direct peer matches this list. |

For example:

```sh
PORT=8080 DATABASE_PATH=/var/lib/dox-u/analytics.sqlite3 TRUSTED_PROXY_IPS=127.0.0.1 cargo run --release
```

The database is created automatically, including the `visits` and `events` tables and indexes for visit history and event lookups. Existing database files are retained; new tables and indexes are added when the server starts.

## Add the script to a website

Use the public HTTPS URL of your DOX-U server:

```html
<script src="https://analytics.example.com/script.js" defer></script>
```

The script works as a collector without requiring an element on the host page. On the DOX-U overview page, it also renders the interactive browser/server comparison when its dashboard elements are present.

The collector enables cross-origin requests so a site on a different domain can post its browser report and events. Use HTTPS in production.

For sites with a Content Security Policy, allow the collector host in `script-src` and `connect-src`. The optional IP geolocation lookups also require `https://ipwho.is` in `connect-src`.

## Track custom events

After the script has loaded, call `window.doxU.track(eventName, properties)`. The method returns a Promise that resolves to the saved event and the server-side data associated with its visit. The current visit ID is available as `window.doxU.sessionId` when you need to call the HTTP endpoint directly.

```html
<button id="signup">Sign up</button>
<script>
  document.getElementById('signup').addEventListener('click', () => {
    window.doxU.track('signup_click', {
      placement: 'header',
      experiment: 'signup-copy-b',
    }).catch(console.error);
  });
</script>
```

The event name must be a non-empty string of at most 128 characters. `properties` must be a JSON object, and the complete event request must be no larger than 64 KiB. Avoid sending secrets or unnecessary personal data in event properties.

The same operation is available directly over HTTP:

```http
POST /api/events
Content-Type: application/json

{
  "sessionId": "<window.doxU.sessionId>",
  "name": "signup_click",
  "properties": {"placement": "header"}
}
```

The JavaScript helper supplies `sessionId` automatically. A successful response includes `id`, `visitId`, `name`, `createdAt`, `properties`, and the visit's `server` data. A visit ID that does not exist returns `404`; invalid event data returns `400`.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Interactive overview, or minimal collector page when `DOX_MODE=collector`. |
| `GET` | `/script.js` | Records the server-side visit and serves the browser collector with its visit context. |
| `POST` | `/api/collect` | Internal endpoint used by the script to attach its browser report and IP lookup results to a visit. |
| `POST` | `/api/events` | Adds a custom event associated with a visit. |
| `GET` | `/visits` | HTML dashboard of saved visits and their events. |

## Stored data and privacy

Each `/script.js` request creates one visit row. The browser report updates that row. Custom events are stored in a separate `events` table with a foreign key to the visit; events can be listed in `/visits` together with that visit's server and browser data. A new script request creates a new visit ID, so events from that page load are grouped with that page's visit.

The collected server and browser details can be sensitive, including IP addresses, page URLs, referrers, device characteristics, and user-submitted event properties. The `/visits` page has no built-in authentication. Restrict access to the dashboard and database with a private network, firewall, or authenticated reverse proxy, and tell site visitors what your deployment collects. Page URLs include query strings and fragments, so do not put credentials or private tokens in tracked URLs.

Public IP geolocation lookups are requested from `ipwho.is` by the visitor's browser; this shares the IP address being looked up with that service. Those requests can fail or be blocked without preventing the visit and event records from being stored. WebRTC address discovery is best-effort and depends on browser behavior and network configuration; the script uses a public STUN server and does not guarantee discovery of a public or VPN-hidden address.

## Deployment notes

SQLite uses bundled SQLite and needs no separate database server. The database directory must be writable. Some free hosting plans use ephemeral filesystems, which can erase the database on restart or redeploy; use a persistent disk or an external database if you need durable storage.

Put the service behind HTTPS when collecting production traffic. If running behind a reverse proxy, set `TRUSTED_PROXY_IPS` to the proxy's direct peer IP address or addresses. The collector then uses the rightmost untrusted address in `X-Forwarded-For`, or `X-Real-IP` as a fallback; otherwise it records the direct socket peer and ignores forwarded headers.
