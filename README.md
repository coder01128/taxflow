# TaxFlow

Bank statement analysis tool — PDF upload, AI-powered extraction, reconciliation, and dashboard.

**Live demo:** [taxflow.vercel.app](https://taxflow.vercel.app)

## Pipeline

1. **Unlock** — Drop password-protected or unlocked PDF bank statements
2. **Extract** — Claude Vision (via server API) reads each page and returns structured transaction data
3. **Reconcile** — Review and categorise transactions, bulk-categorise via CSV/XLSX
4. **Dashboard** — Spending breakdown, income analysis, monthly trends, full ledger with search and export

## Demo mode

Click "Try with sample statement" on the landing screen to load a synthetic 2-page bank statement. The extraction runs live through the server API — no client-side API key needed.

## Tech

- Single HTML file, no build step, no signup
- Vercel serverless function proxies extraction to OpenRouter (Claude Vision)
- pdf-lib for PDF handling, pdf.js for page rendering, ExcelJS for XLSX export
- Dark-theme dashboard with CSS custom properties
- All PDF processing happens in the browser — extraction goes through the server API

## Run locally

```bash
# Set your OpenRouter API key
echo "OPENROUTER_API_KEY=sk-or-v1-your-key" > .env.local

# Start with Vercel dev (handles API routes)
npx vercel dev
```

Then open `http://localhost:3000`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key for Claude Vision extraction |
