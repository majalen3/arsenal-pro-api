# Changelog

## Unreleased — 2026-11-06
- Support MOTIV manufacturer-page discovery and factual specs in the existing live lookup.
- Preserve explicit per-weight RG/differential/PSA data, reject missing/invalid values and do not leak headline numbers into other weights.
- Keep existing manufacturer fetch protections, cache and rate limits. Add parser/discovery/allowlist regressions.
- Local suite: 58/58 passed; no production DB or deployment change.
