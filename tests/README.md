# ProTax test harnesses

No build step, no framework. Each suite is a `<script>` block injected into a
fresh copy of `../protax-app2.html` at run time, so it can never go stale
against the app.

```
python3 build-and-run.py            # both suites
python3 build-and-run.py buckets    # just one
```

jsdom is installed once into `~/.protax-test-deps` on first run and found via
`NODE_PATH`. **Do not `npm install` inside this folder** — node_modules is tens
of thousands of tiny files, and resolving it across a mounted or synced folder
turns a 3-second run into a multi-minute one.

- **harness-buckets.html** — the operating / capital / trading split. Asserts
  against the real figures in `../protax-session.json`, so if the committed
  data changes these numbers must be re-derived from the statements, not
  silently updated to whatever the code now returns.
- **harness-regression.html** — Review (column sort, multi-select, bulk
  categorise, remove-by-source, locked trading rows), CategoryPicker (proves
  the fuzzy "similar transactions" confirm is gone), Ledger (search, category
  filter, sort, paging), the date drum, and every dashboard tab rendering
  after a range change.

Both suites must pass before backing up to `old-builds/`.
