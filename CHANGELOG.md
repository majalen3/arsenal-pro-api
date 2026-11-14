# Changelog

## Unreleased — 2026-11-13 (branch team-moderation, NOT deployed: needs the owner's Render deploy OK)
- My Team moderation v2, additive only. New columns (ADD COLUMN IF NOT EXISTS, no existing data touched): `team_members.hidden_at`, `team_notes.hidden_at`, `team_reports.share_kind`.
- `POST /api/account/teams/:tid/members/:mid/hide` and `POST .../notes/:nid/hide` (secretary only, body `{hidden:true|false}`): hide or Undo. Hidden content is withheld by the server from everyone except the secretary and its owner; nothing is deleted. The secretary cannot hide themself or another secretary.
- Reports can name one shared item (`kind`: bag, stats, tags, regular). The team view now carries `moderation: 2` so the app can show its new buttons only when the server supports them.
- Account export marks `hiddenByTeam`. Tests: one new integration test (report an item, hide, Undo, note hide, permissions, export). Suite 74/74 against a fresh and an existing schema.

## Unreleased — 2026-11-12 (branch spec-chain, not merged or deployed)
- /api/spec-lookup runs a legal source chain: maker page -> archived maker page (Wayback availability API) -> USBC approved list (data/usbc_approved.json, approval date only) -> allowlisted secondary pages. Fill-only merge, `conflicts` for disagreements, per-field `src.type`, `chain` steps in the response.
- bowlingballvideos, bowwwl, bowlingball.com and BowlingThisMonth are hard-banned, including inside archive URLs. Per-host minimum gaps, robots.txt with Crawl-delay, 18 s chain budget; cache key bumped to v3.
- Parser: older Storm "N lbs." weight panels no longer leak the 10 lb headline as the RG/diff.
- scripts/usbc_refresh.mjs rebuilds the USBC data file; scripts/chain-smoke.mjs is a polite live smoke. Tests: test/specchain.test.mjs (10) + storm_archived fixture.

## Unreleased — 2026-11-06
- Support MOTIV manufacturer-page discovery and factual specs in the existing live lookup.
- Preserve explicit per-weight RG/differential/PSA data, reject missing/invalid values and do not leak headline numbers into other weights.
- Keep existing manufacturer fetch protections, cache and rate limits. Add parser/discovery/allowlist regressions.
- Local suite: 58/58 passed; no production DB or deployment change.
