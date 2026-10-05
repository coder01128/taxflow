# TaxFlow — rules for every session

Single-file vanilla HTML/JS app (`index.html`) plus one Vercel serverless function (`api/extract.js`). No frameworks, no build step. The text extraction path must keep working when `index.html` is opened straight from disk (`file://`).

## Design rules (UI)
- All text at least 4.5:1 contrast against its background.
- 13px minimum font size, everywhere.
- No grey-on-grey text on dark backgrounds.
- Every interactive element has `cursor:pointer` and a visible hover state.
- Buttons are filled, or have a visible coloured border.
- Dropdown options are sorted alphabetically.
- No bottom-anchored sheet modals; use centred modals.

## Deploy and secrets
- Deploy only via `git push` to `main`. Never run the Vercel CLI (`vercel`, `vercel dev`, `vercel deploy`, `vercel --prod`).
- Never print, log or commit API keys, secrets or `.env` contents.
- Statement data never enters the repo: real statements live outside it (e.g. `C:\ccode\test-statements`), and test output containing statement data stays outside it (e.g. `C:\ccode\taxflow-lab`).

## Extraction
- Text-first: PDFs are read from their text layer and every row is checked against the printed running balance. Vision (image → AI) is only the fallback for pages with no usable text or rows that don't balance.
- Vision model string: `anthropic/claude-sonnet-5` via OpenRouter, set server-side in `api/extract.js` only.
- Tests: `node tests/run-harness.js` (see `tests/README.md`). It needs the statements folder and makes no network calls.
