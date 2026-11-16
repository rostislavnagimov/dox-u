# Project summary

DOX-U is a self-hosted Rust analytics collector. A browser request for `/script.js` creates a SQLite visit record with server-observed data; the script then attaches browser-side data and geolocation lookup results. Sites can submit custom events through `window.doxU.track()` or `POST /api/events`, with each event joined to its visit record by a foreign key. The `/` overview and `/visits` dashboard provide the existing visual interface.

See [README.md](README.md) for setup, integration, event tracking, configuration, and deployment details.
