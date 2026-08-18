# Play Sabotage

Free multiplayer board game inspired by Malefiz/Barricade: race your pawns to the goal, block opponents with barricades, use powerups. Play with friends, locally, or vs AI.

Live at **[www.playsabotage.com](https://www.playsabotage.com)**.

> This repository is named `Malefiz` after the classic board game it's inspired by — the product itself is called Play Sabotage.

## Architecture

Two separate deployments, wired together by hardcoded absolute URLs in the client. This isn't obvious from `vercel.json` alone, which only holds a static-SPA rewrite and response headers.

- **Frontend** — the entire client lives in a single `index.html`, deployed as a static site on **Vercel**, serving both `malefiz.vercel.app` and the custom domain `www.playsabotage.com`.
- **Backend** — `server.js` (Express + Socket.io + Postgres), deployed separately on **Railway** at `malefiz-production.up.railway.app`. The client connects to it via hardcoded absolute URLs, not same-origin.

**Stack:** Express + Socket.io (realtime multiplayer) + Postgres + JWT auth (bcrypt).

## Local development

```
npm install
npm start
```

The server needs a Postgres connection and the environment variables below. There's no separate build step — `index.html` is served as-is.

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `JWT_SECRET` | Signs auth tokens. **The server refuses to start in production if this is unset** — there is no fallback secret in production, by design (a hardcoded fallback used to ship in this repo; it was a real vulnerability, see the security section below). |
| `PGSSLROOTCERT` | CA certificate (PEM) for the Postgres TLS connection. Railway's Postgres presents a self-signed chain with no publicly-trusted CA, so this must be set for the deploy environment or **every database query fails outright** (not a silent degradation — you'll see it immediately in the logs and in every DB-backed request). |

## Standing maintenance obligations

Two things about this repo are easy to forget and will cause quiet production breakage if missed:

- **`socket.io.js`** (vendored at the repo root, served same-origin from Vercel) must be regenerated whenever the `socket.io` npm dependency is upgraded, or the deployed client and server versions can drift. Regenerate from `node_modules/socket.io/client-dist/socket.io.min.js`.
- **`PGSSLROOTCERT`** must stay set on the Railway `Malefiz` service. If it's ever missing, the server logs a startup warning and every DB query fails.

## Security

A codebase audit (2026-08-18) found and fixed a set of vulnerabilities, including a stored-XSS path via chat, a reconnect-secret broadcast leak, a hardcoded JWT fallback secret, weak randomness for room codes/secrets, missing auth rate limiting, and a cross-origin script load with no integrity pinning. All of those are resolved on `main`.

Known, deliberately deferred limitations:

- **No authoritative server-side game validation.** `game-action` events are relayed between clients without the server checking move legality — a modified client can currently forge moves. Acceptable for casual play with friends; would need addressing before any competitive/ranked mode.
- **CORS is fully open** (`Access-Control-Allow-Origin: *`) on the API, including the auth routes. Not a classic CSRF hole since auth is bearer-token rather than cookie-based, but a proper fix needs an origin allowlist designed around the split Vercel/Railway architecture.

If you find a security issue, please open an issue or contact the maintainer directly rather than filing a public PR with exploit details.

## License / terms

The source is public for transparency, but this repository is **not licensed for reuse or redistribution** — there is no open-source license grant, and the absence of a LICENSE file means normal copyright applies (all rights reserved). "Free to play" describes the price of the hosted game, not a license to fork or redistribute the code.
