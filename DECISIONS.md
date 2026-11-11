# Decisions

## MOTIV factual spec lookup (2026-11-06)
- Add `motivbowling.com` / `www.motivbowling.com` to the existing manufacturer allowlist, not a general URL fetcher. Product discovery reads maker sitemap entries under `/products/balls/`; `.html` is removed for model-name matching.
- Use the existing guarded fetch (robots rules/crawl delay, host/redirect/size/time limits), cache, request/body validation, route rate limits and candidate-confirmation flow. No new endpoint, credential, third-party service, database write or rate-limit change.
- Read printed facts only. MOTIV's weight-specific panels take precedence over headline RG/differential values. Parse Max Differential and Int. Differential aliases; absent/invalid values remain absent. Never copy one weight's number into a different panel or infer a missing spec.
- Local tests cover explicit weight facts, missing headline leakage, exact/ambiguous/unknown cached-sitemap discovery and lookalike-host rejection. A factual Jackal Ghost V2 fixture is based on the maker page; it is not an accuracy claim about bowling motion.
- Local-only verification: 58 API tests pass against an isolated database/test server. No live database writes or deployment. This feature deploys through the normal flow only after the PR is reviewed and merged.
