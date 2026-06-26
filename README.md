# Orbital — TLE Proxy Server

CORS-safe proxy that fetches and caches TLE data from Celestrak for the Orbital satellite tracker PWA.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /tle/:group` | TLE array for a group |
| `GET /tle/multi?groups=` | Batch fetch (comma-separated, max 6) |
| `GET /iss` | Live ISS position |
| `GET /health` | Cache status |

## Groups

`stations` · `visual` · `starlink` · `weather` · `gps` · `oneweb` · `iridium`

## Deploy to Railway

1. Push this repo to GitHub
2. Connect repo in Railway → Deploy
3. Copy your Railway URL (e.g. `https://orbital-proxy-production.up.railway.app`)
4. Paste into the Orbital PWA as `PROXY_BASE`

## Cache

TLEs are cached for 2 hours and refreshed on next request. `stations` and `visual` are pre-warmed on startup.

## Data Source

[Celestrak](https://celestrak.org) — free, public TLE data. No API key required.
