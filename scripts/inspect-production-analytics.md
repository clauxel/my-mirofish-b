# Production Inspection Script

This script turns the MiroFish B Cloudflare Pages and analytics checks into one reusable read-only command.

Current script path: `scripts/inspect-production-analytics.mjs`

## What it checks

- Reads analytics from the Cloudflare D1 database `mirofish-b-analytics` by default
- Uses `https://mirofish.best` as the public site origin unless overridden
- Summarizes referrers, hostnames, landing paths, page routes, CTA clicks, funnel movement, checkout failures, and deduplicated payments
- Can still query the legacy PostgreSQL source with `--local-db` or remote SSH mode when explicitly requested

## Commands

Run the default MiroFish B D1 text report:

```bash
npm run prod:inspect
```

Write a JSON report:

```bash
npm run prod:inspect -- --format json --output ../推广/exports/mirofish-b-production-analytics-report.json
```

Health-check the live public origin while reading remote D1:

```bash
npm run prod:inspect -- --origin https://mirofish.best
```

Query a different D1 database:

```bash
npm run prod:inspect -- --d1-database mirofish-b-analytics
```

Query local Wrangler D1 instead of remote D1:

```bash
npm run prod:inspect -- --d1-local --skip-health
```

Use the legacy PostgreSQL source explicitly:

```bash
node scripts/inspect-production-analytics.mjs --local-db --skip-health
```

## Data Source

- `npm run prod:inspect` defaults to Cloudflare D1: `mirofish-b-analytics`.
- The Pages project is `my-mirofish-b`, and the canonical production origin is `https://mirofish.best`.
- D1 queries are executed through Wrangler, so the local Cloudflare login must have access to the database.
- The analytics endpoint writes page views, section views, CTA clicks, checkout events, payment completions, UTM fields, device type, and hostname into D1.
- The report is read-only. It does not modify Cloudflare, the site, or the database.
