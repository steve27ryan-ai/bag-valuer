# Siopaella Google Ads Agent — Architecture (agreed plan, v1)

Status: **planning / Phase 0**. No code talks to Google Ads yet. Nothing goes live without written sign-off.

## Decisions so far
| Topic | Decision |
|---|---|
| Where it runs | Owner's always-on desktop Mac, scheduled with macOS `launchd` |
| Storage | SQLite file on the Mac (`data/ads.db`), daily snapshots |
| Language | Python + Google's official `google-ads` client library |
| Approvals | Reply to the daily email, e.g. `APPROVE 1, 3` / `REJECT 2`. The Mac reads replies from the inbox |
| Shopping curation | Brand/model/price-band rules in `config.yaml` → written to the feed as custom labels |
| Margin data | Comes from consignment software (name TBC); fallback = commission % by price band |
| Accounts in place | Google Ads (empty), Merchant Center, Shopify "Google & YouTube" app |

## Components
1. **Collectors** — Google Ads API (spend, clicks, conversions, value, search terms, products, disapprovals),
   Shopify Admin API (stock, prices, tags), margin import.
2. **Rules engine** (plain code, fully tested) — budget cap, guardrails, waste detection, tracking alarms,
   auto-negatives, sold-item exclusion. All money decisions live here; no AI involved.
3. **Report writer** — Claude turns the rules engine's findings into a short phone-readable email.
   It can suggest, never act.
4. **Approval inbox** — parses replies; only exact proposal IDs from that day's email are accepted,
   only from the owner's address, and expire after 48h.
5. **Executor** — applies approved changes; every write logged (what, when, before/after, why).

## Modes
`read-only` (default) · `dry-run` (prints what would change) · `approved` (applies approved items + safe auto-actions).

## Budget hard stop (two layers)
- Daily budgets total ≈ €12.50 → Google's own monthly limit (daily × 30.4) ≈ €380.
- Agent checks month-to-date spend every 3 hours; pauses all campaigns at €385. Resumes only on approval or the 1st of the month.
- Budget raises capped at +20% per change; the agent recalculates remaining-month headroom before proposing any.

## Reporting rules
- Brand and non-brand reported separately; 8x ROAS judged on rolling 4 weeks, mainly non-brand.
- Tracking alarm: conversions at zero for 7+ days while clicks continue, or order value missing.

## Starting campaigns (draft — for approval in Phase 0 step 4)
1. Brand Search "Siopaella" — manual CPC, ~€2.50/day.
2. Shopping, curated product groups — manual CPC with per-group caps, ~€10/day.
Not at launch: consignor campaign, PMax, Display, UK/EU.

## Phases
0 Setup & tracking → 1 Read-only reporting → 2 Recommendations → 3 Approved actions. Each tested before the next.
