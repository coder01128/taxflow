#!/usr/bin/env node
/* TaxFlow text-first harness. No network calls, no AI calls.

   Runs the SAME code the app runs — the <script id="tf-core"> block inside
   index.html (TF.runBatch → TF.processFile) — on every PDF in a folder,
   using pdfjs-dist (same version as index.html) instead of the browser build.

     node tests/run-harness.js [--dir <folder>] [--expect <json>] [--core <file>]

   --dir     folder of statement PDFs (default C:\ccode\test-statements)
   --expect  optional JSON of expected numbers keyed by "<Bank> <YYYY-MM>"
             (kept OUTSIDE the repo, with the statements)
   --core    load the core from a standalone file instead of index.html
   Password-protected PDFs: set TAXFLOW_PDF_PW in the environment.

   Output never contains file names, account numbers or transaction lines:
   each statement is labelled "<Bank> <YYYY-MM>" (month of its last row).
   Nothing is written to disk. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('--dir', 'C:\\ccode\\test-statements');
const EXPECT = opt('--expect', null);
const CORE = opt('--core', null);
const ROOT = path.resolve(__dirname, '..');

// ---- load the core exactly as the app has it ----
function loadCore() {
  let src;
  if (CORE) src = fs.readFileSync(CORE, 'utf8');
  else {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<script id="tf-core">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('No <script id="tf-core"> block in index.html');
    src = m[1];
  }
  vm.runInThisContext(src, { filename: CORE || 'index.html#tf-core' });
  return globalThis.TF;
}

// pdf.js warns at load time that the optional `canvas` package is missing.
// Text extraction doesn't need it; keep the output readable.
const _log = console.log;
console.log = (...a) => { if (!/Cannot polyfill|canvas/.test(String(a[0]))) _log(...a); };
const pdfjsLib = require(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.js'));
console.log = _log;

const TF = loadCore();
const label = r => `${r.bank} ${r.period ? r.period.to.slice(0, 7) : '?'}`;
// first day of the month after `iso` (synthetic "next statement" periods)
const nextMonth = (iso) => { const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 1)); return d.toISOString().slice(0, 10); };
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const pass = (msg) => console.log('  pass ' + msg);

const noVision = {
  renderPageImage: async () => { throw new Error('vision disabled in harness'); },
  callVision: async () => { throw new Error('vision disabled in harness'); },
};
const baseDeps = (extra) => Object.assign({
  pdfjsLib, docOptions: { disableFontFace: true, verbosity: 0 }, concurrency: 3,
}, noVision, extra || {});

function loadFiles() {
  return fs.readdirSync(DIR).filter(f => /\.pdf$/i.test(f)).sort().map(f => ({
    name: f, bytes: new Uint8Array(fs.readFileSync(path.join(DIR, f))),
    password: process.env.TAXFLOW_PDF_PW || undefined,
  }));
}

(async () => {
  const files = loadFiles();
  console.log(`\n== 1. Acceptance: ${files.length} PDF(s), text path only, no network ==`);
  const results = await TF.runBatch(files, baseDeps());
  const expect = EXPECT ? JSON.parse(fs.readFileSync(EXPECT, 'utf8')) : null;
  console.log('statement        | rows | row checks | whole stmt | printed totals            | continuity | text/vision | ms/page | font decoding');
  for (const r of results) {
    if (r.error) { fail(`a file could not be read: ${r.error}`); continue; }
    const tot = r.whole.printed.map(p => `${p.name}:${p.ok ? 'ok' : 'MISMATCH'}`).join(',') || 'none printed';
    const fm = Object.values(r.fontModes).includes('encoding') ? 'ToUnicode broken → font encoding' : 'normal';
    console.log(`${label(r).padEnd(16)} | ${String(r.rows.length).padStart(4)} | ${(r.rowSummary.passed + '/' + r.rowSummary.total).padStart(10)} | ` +
      `${(r.whole.ok ? 'PASS' : 'FAIL').padEnd(10)} | ${tot.padEnd(25)} | ${r.continuity.status.padEnd(10)} | ` +
      `${(r.counts.text + '/' + r.counts.vision).padEnd(11)} | ${(r.ms / r.pages).toFixed(0).padStart(7)} | ${fm}`);
    if (expect) {
      const e = expect[label(r)];
      if (!e) fail(`${label(r)}: no expectation`);
      else if (e.rows !== r.rows.length || e.passed !== r.rowSummary.passed || e.whole !== r.whole.ok)
        fail(`${label(r)}: expected ${e.rows} rows, ${e.passed} passed, whole ${e.whole}; got ${r.rows.length}, ${r.rowSummary.passed}, ${r.whole.ok}`);
      else pass(`${label(r)} matches acceptance (${e.rows} rows, ${e.passed}/${e.rows}, whole PASS)`);
    }
  }
  const ok = results.filter(r => !r.error);
  const cats = ok.flatMap(r => r.txns);
  const unc = cats.filter(t => t.category === 'Uncategorised').length;
  console.log(`categorised: ${cats.length - unc}/${cats.length} rows matched a keyword rule; ` +
    `${cats.every(t => TF.CATEGORIES.includes(t.category)) ? 'all' : 'NOT all'} categories valid`);

  // ---- 2. sabotage: the checks must be able to fail ----
  console.log('\n== 2. Sabotage tests (in memory) ==');
  const clone = rows => rows.map(r => Object.assign({}, r));
  for (const r of ok) {
    const mid = Math.floor(r.rows.length / 2);
    const a = clone(r.rows); a[mid].amount += 1;
    const sa = TF.checkRows(r.opening, a), wa = TF.wholeStatement(r.opening, a, r.closingSource === 'printed' ? r.closing : null, {});
    const b = clone(r.rows); b.splice(mid, 1);
    const sb = TF.checkRows(r.opening, b), wb = TF.wholeStatement(r.opening, b, r.closingSource === 'printed' ? r.closing : null, {});
    const c = clone(r.rows); c.pop();
    const sc = TF.checkRows(r.opening, c), wc = TF.wholeStatement(r.opening, c, r.closingSource === 'printed' ? r.closing : null, {});
    // continuity closes the last-row blind spot: the next statement opens at the TRUE closing balance
    const truncated = Object.assign({}, r, { name: 'A', closing: wc.closing, period: r.period });
    const follower = { name: 'B', bank: r.bank, accountKey: r.accountKey, opening: r.closing, closing: r.closing,
      period: { from: nextMonth(r.period.to), to: nextMonth(r.period.to) } };
    TF.continuity([truncated, follower]);
    const cCaught = !wc.balanceOk || follower.continuity.status === 'break';
    console.log(`${label(r).padEnd(16)} | A amount+R1: ${sa.failed} row fail, whole ${wa.balanceOk ? 'pass' : 'FAIL'}` +
      ` | B middle row deleted: ${sb.failed} row fail, whole ${wb.balanceOk ? 'pass' : 'FAIL'}` +
      ` | C last row deleted: whole ${wc.balanceOk ? 'pass' : 'FAIL'}, continuity vs next statement ${follower.continuity.status}` +
      ` → ${cCaught ? 'caught' : 'MISSED'} (${r.closingSource === 'printed' ? 'printed closing balance' : 'continuity only'})`);
    if (sa.failed !== 1 || wa.balanceOk) fail(`${label(r)} sabotage A not caught`);
    if (sb.failed !== 1 || wb.balanceOk) fail(`${label(r)} sabotage B not caught`);
    if (!cCaught) fail(`${label(r)} sabotage C not caught`);
  }

  // ---- 3. continuity: synthetic consecutive statement ----
  console.log('\n== 3. Continuity ==');
  for (const r of ok) console.log(`${label(r).padEnd(16)} | ${r.continuity.status}${r.continuity.months ? ' (' + r.continuity.months + ' month(s) missing)' : ''}`);
  {
    const r = ok[0];
    const good = { name: 'next', bank: r.bank, accountKey: r.accountKey, opening: r.closing, closing: 0, period: { from: nextMonth(r.period.to), to: nextMonth(r.period.to) } };
    const bad = Object.assign({}, good, { opening: r.closing + 10 });
    const other = Object.assign({}, good, { accountKey: 'zzzz' });
    TF.continuity([Object.assign({}, r), good]); TF.continuity([Object.assign({}, r), bad]); TF.continuity([Object.assign({}, r), other]);
    good.continuity.status === 'ok' ? pass('consecutive statement with matching balance → ok') : fail('continuity ok case');
    bad.continuity.status === 'break' ? pass('consecutive statement with R10 difference → break') : fail('continuity break case');
    other.continuity.status === 'first' ? pass('different account is not compared') : fail('continuity account grouping');
  }

  // ---- 4. vision fallback with a mocked API (no network, no cost) ----
  console.log('\n== 4. Vision fallback (mocked API) ==');
  // one statement per bank (the one with the most pages)
  const targets = Object.values(ok.reduce((m, r) => { if (!m[r.bank] || r.pages > m[r.bank].pages) m[r.bank] = r; return m; }, {}));
  for (const target of targets) {
    const file = files.find(f => f.name === target.name);
    const truth = {};
    target.rows.forEach(r => { (truth[r.page] = truth[r.page] || []).push(r); });
    // What the vision prompt asks for: bank fees in `fee` (positive), never inside `amount`.
    const asVision = (rows) => ({ transactions: rows.map(r => ({
      post_date: r.iso, reference: r.reference, amount: Math.round((r.amount - (r.star || 0)) * 100) / 100,
      fee: Math.abs(r.fee) + Math.abs(r.star || 0), balance: r.balance })) });
    function mock({ failFirst = [], failAlways = [], corrupt = [] }) {
      const st = { inflight: 0, max: 0, calls: {} };
      return {
        st,
        renderPageImage: async (p) => 'MOCKJPEG' + p.pageNumber,
        callVision: async (img, ctx) => {
          st.inflight++; st.max = Math.max(st.max, st.inflight);
          st.calls[ctx.page] = (st.calls[ctx.page] || 0) + 1;
          await new Promise(res => setTimeout(res, 40));
          st.inflight--;
          if (failAlways.includes(ctx.page)) throw new Error('mock HTTP 502');
          if (failFirst.includes(ctx.page) && st.calls[ctx.page] === 1) throw new Error('mock timeout');
          const rows = (truth[ctx.page] || []).map(r => Object.assign({}, r));
          if (corrupt.includes(ctx.page) && rows.length) rows[Math.floor(rows.length / 2)].amount += 1;
          const out = asVision(rows);
          // the prompt asks for the opening balance when the page shows one (first transaction page)
          if (ctx.page === Math.min(...Object.keys(truth).map(Number))) out.opening_balance = target.opening;
          return out;
        },
      };
    }
    const txnPages = Object.keys(truth).map(Number);
    const blank = (pns) => (pages) => pns.forEach(pn => { pages[pn - 1].chars = []; });
    console.log(`using ${label(target)} (${target.pages} pages, transactions on pages ${txnPages.join(',')})`);

    { // 4a: every transaction page forced to vision: parallelism + retry
      const m = mock({ failFirst: [txnPages[1]] });
      const res = await TF.processFile(file, baseDeps({ renderPageImage: m.renderPageImage, callVision: m.callVision, forceVisionPages: new Set(txnPages) }));
      console.log(`4a all txn pages via vision: max ${m.st.max} calls in flight, calls per page ${JSON.stringify(m.st.calls)}, ` +
        `rows ${res.rows.length}, ${res.rowSummary.passed}/${res.rowSummary.total} verified, text/vision ${res.counts.text}/${res.counts.vision}, status ${res.status}`);
      m.st.max <= 3 && m.st.max > 1 ? pass('vision runs in parallel, at most 3 at a time') : fail(`concurrency ${m.st.max}`);
      m.st.calls[txnPages[1]] === 2 && Object.entries(m.st.calls).every(([p, n]) => +p === txnPages[1] || n === 1)
        ? pass('failed page retried once on its own; no other page re-sent') : fail('retry behaviour');
      res.status === 'reconciled' && res.counts.vision === target.rows.length ? pass('vision rows went through the balance checks and reconciled') : fail('4a reconcile');
    }
    { // 4b: a page with no text layer goes to vision automatically
      const pn = txnPages[0];
      const m = mock({});
      const res = await TF.processFile(file, baseDeps({ renderPageImage: m.renderPageImage, callVision: m.callVision, transformPages: blank([pn]) }));
      console.log(`4b page ${pn} text removed: vision called for pages ${Object.keys(m.st.calls).join(',')}, text/vision ${res.counts.text}/${res.counts.vision}, status ${res.status}`);
      JSON.stringify(Object.keys(m.st.calls).map(Number)) === JSON.stringify([pn]) && res.status === 'reconciled'
        ? pass('textless page detected, only that page sent to vision, file reconciles') : fail('4b');
    }
    { // 4c: vision output that doesn't balance is caught
      const pn = txnPages[0];
      const m = mock({ corrupt: [pn] });
      const res = await TF.processFile(file, baseDeps({ renderPageImage: m.renderPageImage, callVision: m.callVision, transformPages: blank([pn]) }));
      const bad = res.rows.filter(r => r.ok === false);
      console.log(`4c page ${pn} via vision with one wrong amount: ${bad.length} row(s) flagged (path ${bad.map(r => r.path).join(',')}), status ${res.status}`);
      bad.length === 1 && bad[0].path === 'vision' && res.status === 'unbalanced' ? pass('bad vision row flagged, file marked unbalanced') : fail('4c');
    }
    { // 4d: vision fails twice → page reported, file unbalanced, nothing else re-sent
      const pn = txnPages[0];
      const m = mock({ failAlways: [pn] });
      const res = await TF.processFile(file, baseDeps({ renderPageImage: m.renderPageImage, callVision: m.callVision, transformPages: blank([pn]) }));
      const info = res.pageInfo[pn - 1];
      console.log(`4d page ${pn} vision always fails: attempts ${info.attempts}, error "${info.visionError}", status ${res.status}`);
      info.attempts === 2 && info.visionError && res.status === 'unbalanced' ? pass('gave up after one retry, error recorded, file flagged') : fail('4d');
    }
  }

  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
