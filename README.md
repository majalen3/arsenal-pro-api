# Arsenal Pro API

Small Node/Express + Postgres API for the Urbanek Honey Badgers Arsenal Pro bowling app
(https://majalen3.github.io/arsenal-pro-bowling/).

**Data scope:** the app has no user accounts, so all data is global (one shared team store). Anyone with the URL can read/write it. Don't store anything private.

## Run
`DATABASE_URL=postgres://... npm install && npm start` (tables are created on startup; DB connection is retried).

## Endpoints (JSON, CORS `*`, 20kb body limit)
- `GET /api/health`
- `POST /api/lines` `{ballId,name,release,aim,speed,rev,oil?,finish,pattern,note}` — upsert by ballId+name
- `GET /api/lines?ballId=...`
- `DELETE /api/lines/:id`
- `POST /api/surface-log` `{ballId,date:"YYYY-MM-DD",finish}`
- `GET /api/surface-log?ballId=...`
- `POST /api/pattern-notes` `{lane,oil,adjustment}`
- `GET /api/pattern-notes`
