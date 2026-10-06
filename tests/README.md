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
  (`separate`, `included` or `none`).
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
