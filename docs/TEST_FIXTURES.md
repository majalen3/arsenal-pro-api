# Isolated API test fixtures (7 November 2026, Europe/Zurich)

This branch is stacked on unmerged MOTIV PR1 (`8691719`). It changes **test tooling/CI only**. `server.js`, production environment, real SESSION_PEPPER, rate limits and all deployment configuration are unchanged. No live service, production database, real account or credential was accessed.

## Verified inherited failure

Run42235100294:58 tests,42 pass/16 fail. Account/team routes return503, explicitly `SESSION_PEPPER missing`; CI started the server without it. The >=32-character guard is correct and is retained, not bypassed. Team/account fixture headers already required larger **test-only** signup/create/join limits. Login's8/email and20/IP limits stay active, including the429 regression.

## Run on a NEW disposable empty local PostgreSQL database

Provision a local isolated PostgreSQL16+ database yourself (not a live/Render database). The runner will not create, drop, truncate or clear any database and refuses one with public tables. All generated accounts/team/history are synthetic fixtures inside that local database only. Never reuse private data or a live service.

```sh
npm ci
ALLOW_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://u:p@127.0.0.1:5432/t npm run test:local
```

`u`, `p`, `t` and the pepper in `scripts/test-fixture.mjs` are PUBLIC SYNTHETIC VALUES, never deployment credentials. Alternatively use database name `arsenal_test_*`, optional `TEST_PORT`. Loopback hosts only; remote URLs, URL query overrides and other DB names fail before connecting. The runner uses its own server, checks DB/schema readiness, supplies TEST_DATABASE_URL to exercise invite expiry, and shuts down its server afterward. CI uses a fresh PostgreSQL16 service and exactly this runner, with `pg_isready -U u -d t`. No production secret is needed.

## Local evidence / remaining gates

- Pure fixture+MOTIV/spec tests:18/0, exit0 (`node --test test/fixture.test.mjs test/specs.test.mjs`). Guards reject remote/ambiguous DB inputs and replace inherited fixture destinations/secrets.
- Full local PostgreSQL run **blocked**, not passed: this box has client17 only, no server/initdb/pg_ctl. Installing the server was attempted through apt; package-index fetches returned HTTP500 and no signed server candidate was available. Explicit local runner attempt returned ECONNREFUSED127.0.0.1:55491, exit1, before any test/server/data write. No lower-level download, unsigned package or production substitute was used. Hosted CI results are reported with the PR delivery, separately from this local blocker.
- `npm audit --json` exit1: inherited high body-parser DoS advisory [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), affected<1.20.9. Dependency lockfile remains unchanged. This is a separate production-dependency review/release gate; no automatic `audit fix`, session change or risky production dependency adjustment was attempted.
- All auth/isolation/CORS/recovery/login-rate expectations remain unchanged. A green hosted fixture run would not establish production durability, auth configuration, legal readiness or permission to merge/deploy.
