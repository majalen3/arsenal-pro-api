# Decisions

## MOTIV factual spec lookup (2026-11-06)
- Add `motivbowling.com` / `www.motivbowling.com` to the existing manufacturer allowlist, not a general URL fetcher. Product discovery reads maker sitemap entries under `/products/balls/`; `.html` is removed for model-name matching.
- Use the existing guarded fetch (robots rules/crawl delay, host/redirect/size/time limits), cache, request/body validation, route rate limits and candidate-confirmation flow. No new endpoint, credential, third-party service, database write or rate-limit change.
- Read printed facts only. MOTIV's weight-specific panels take precedence over headline RG/differential values. Parse Max Differential and Int. Differential aliases; absent/invalid values remain absent. Never copy one weight's number into a different panel or infer a missing spec.
- Local tests cover explicit weight facts, missing headline leakage, exact/ambiguous/unknown cached-sitemap discovery and lookalike-host rejection. A factual Jackal Ghost V2 fixture is based on the maker page; it is not an accuracy claim about bowling motion.
- Local-only verification: 58 API tests pass against an isolated database/test server. No live database writes or deployment. This feature deploys through the normal flow only after the PR is reviewed and merged.


## Spec lookup source chain (2026-11-12)
Decision: after the maker page, the lookup tries an archived maker page, then the bundled USBC approved list, then allowlisted secondary pages, only for fields still missing. Why: owner t139u wants the research used when a ball is picked in Add a ball. Consequences: banned hosts are rejected in code; Wayback is rate-limited (2.5 s) and capped by an 18 s budget; USBC supplies approval date only (never release date); forums are never fetched; the user confirms in the app before anything is saved. Deploy bumps cache key to v3 (old entries ignored). Refresh the USBC file with `node scripts/usbc_refresh.mjs` when the list is republished.


## My Team moderation v2: hide before remove (2026-11-13, owner t150u "Do it")
Decision: the secretary gets a reversible Hide (member or one note) next to the permanent Remove, and a report can point at one shared item. Why: launch needs a way to stop abuse that does not destroy a teammate's data on a first report; Remove (cascade delete) stays for confirmed cases. Hidden content is withheld server-side, not just in the app, so a modified client cannot read it. Block is local to the phone (the app's prefs) and never sent to the server, so nobody learns who blocked whom. Migration is three ADD COLUMN IF NOT EXISTS statements; nothing existing is altered or deleted. Deploy: the service auto-deploys on merge to main, so this PR is left open until the owner approves a deploy; the app hides the new buttons until the team view reports `moderation: 2`.
