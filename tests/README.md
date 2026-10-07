# TaxFlow tests

No build step, no framework, no network calls, no AI calls.

## Statement harness — `run-harness.js`

Runs the app's own extraction code (the `<script id="tf-core">` block inside
`index.html`) in Node, using `pdfjs-dist` pinned to the same pdf.js version
`index.html` loads.

```bash
node tests/run-harness.js --dir C:\ccode\test-statements --expect C:\ccode\taxflow-lab\expected.json
```

- `--dir` — a folder of statement PDFs. Real statements stay **outside** the repo.
- `--expect` — optional JSON of expected results, keyed `"<Bank> <YYYY-MM>"`, e.g.
  `{"Capitec 2024-09": {"rows": 36, "passed": 36, "whole": true}}`. Keep it with the statements, not in the repo.
  An expectation may instead be keyed by file name (two statements can end in the same month), with an
  `"alias"` that is printed in place of the name. Optional `"fee"`: the expected fee convention
  (`separate`, `included` or `none`). Optional `"duplicateOf"`: the alias of the statement a file
  copies (a file without it must not be flagged as a duplicate).
- Both flags repeat: `--dir A --dir B --expect a.json --expect b.json` runs each folder as its own batch
  and merges the expectation files.
- Password-protected PDFs: set `TAXFLOW_PDF_PW` in the environment for that run.

It checks, per statement: rows found, per-row running-balance checks,
the whole-statement check and printed totals, continuity between
consecutive statements of the same account, and text vs vision counts.
Then it runs sabotage tests (change an amount by R1, delete a middle row,
delete the last row) to prove the checks can fail, fee-convention sabotage
(the other convention over the whole statement must not balance; one row
rewritten to the other convention must leave no convention that fits), and vision-fallback
tests with a mocked API (parallelism capped at 3, one retry per page,
textless pages, bad vision rows, a page that never comes back).

Output never includes file names, account numbers or transaction lines.
The synthetic sample also works: `node tests/run-harness.js --dir samples`.

## API endpoint — `api-extract.test.js`

```bash
node tests/api-extract.test.js
```

Exercises `api/extract.js` with a mocked `fetch` and a dummy key that exists
only inside the test process: method/image/size/format checks, that the
browser can't override the prompt, model or max_tokens, and the error paths.

## Categorisation — `merchant-key.test.js`, `categorise.test.js`, `api-categorise.test.js`

```bash
node tests/merchant-key.test.js
node tests/categorise.test.js
node tests/api-categorise.test.js
```

Made-up references only, no network. `merchant-key` checks the normaliser
(shapes, same merchant across formats, similar merchants never merging, no
numbers surviving). `categorise` checks the precedence (confirmed memory →
rule → AI suggestion → needs review), merchant memory and one-click
propagation, and the AI flow with a mocked AI: only unseen, non-private
merchant keys are sent, high/low/invalid answers, failure, opened from
disk, 200-key batching. `api-categorise` exercises `api/categorise.js` like
the extract test (limits, refusing raw references, fixed prompt/model,
category list equal to the app's).

## Balance correction — `correction.test.js`

```bash
node tests/correction.test.js [--image <image-only sample>] [--bad <bad-balance pdf>]
```

Unit cases, plus the image-only copy of the sample with a mocked vision
misread (must be offered exactly R28,500.00) and the bad-balance file (no
offer). Both PDFs default to the lab folder outside the repo.

## Browser — `browser-dedupe.test.mjs`

```bash
node tests/browser-dedupe.test.mjs [--chrome <path to chrome.exe>]
```

Drives headless Chrome over the DevTools protocol (no npm packages) with the
built-in sample: "Remove Source" must forget the statement's fingerprint, so
uploading it again is not a duplicate, and its rows must not come back.
