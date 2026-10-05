# TaxFlow

Bank statement analysis tool: PDF upload, text-first extraction with real reconciliation, categorisation and a dashboard.

**Live:** [taxflow-bk.vercel.app](https://taxflow-bk.vercel.app)

## Pipeline

1. **Unlock** — drop password-protected or unlocked PDF bank statements. pdf.js checks the password; nothing is uploaded.
2. **Extract** — each statement is read from its PDF text layer in the browser and every row is checked against the bank's printed running balance. Only pages with no readable text, or rows that don't balance, are sent to the AI vision fallback (server API, max 3 pages at a time, one retry per page). The screen shows, per file: rows verified, opening/closing balance, printed totals, continuity with the previous statement of the same account, and how many rows came from text vs vision. Rows that don't balance are listed and can be opened in Review.
3. **Review** — categorise (keyword rules run automatically; edit one row, several at once, or round-trip through Excel), filter to unbalanced rows, then commit.
4. **Dashboard** — spending, income, monthly trends, full ledger with search and CSV export.

## Demo mode

Click "Try with sample statement" on the first screen to load a synthetic 2-page statement. It runs entirely in the browser (no API call), including when `index.html` is opened straight from disk.

## Tech

- Single HTML file, no build step, no signup.
- pdf.js reads each glyph's position and raw character code, so statements whose fonts have broken Unicode maps (e.g. Capitec 2024) still read correctly.
- A Vercel serverless function (`api/extract.js`) is the vision fallback only. Its prompt, model (`anthropic/claude-sonnet-5` via OpenRouter) and limits are fixed server-side.
- ExcelJS for .xlsx export/import.

## Run locally

Text extraction, reconciliation, review and the dashboard need no server: open `index.html` in a browser. The vision fallback needs the deployed app (it calls `/api/extract`).

Deploys happen by pushing to `main`. Don't use the Vercel CLI (see `CLAUDE.md`).

## Tests

See `tests/README.md`. `npm run test:api` needs nothing; `npm run test:statements` needs a folder of statements outside the repo.

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key for the vision fallback (server-side only) |
