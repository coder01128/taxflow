#!/usr/bin/env node
/* TaxFlow text-first harness. No network calls, no AI calls.

   Runs the SAME code the app runs — the <script id="tf-core"> block inside
   index.html (TF.runBatch → TF.processFile) — on every PDF in a folder,
   using pdfjs-dist (same version as index.html) instead of the browser build.

     node tests/run-harness.js [--dir <folder>]... [--expect <json>]... [--core <file>]

   --dir     folder of statement PDFs (default C:\ccode\test-statements).
             Repeat to run several folders; each folder is its own batch
             (continuity is checked within a folder).
   --expect  optional JSON of expected numbers keyed by "<Bank> <YYYY-MM>"
             (kept OUTSIDE the repo, with the statements). Repeat to merge
             several files. Optional "fee" key: expected fee convention.
   --core    load the core from a standalone file instead of index.html
   Password-protected PDFs: set TAXFLOW_PDF_PW in the environment.

   Output never contains file names, account numbers or transaction lines:
   each statement is labelled "<Bank> <YYYY-MM>" (month of its last row).
   Nothing is written to disk. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const url = require('url');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const opts = (k) => args.flatMap((a, i) => a === k && i + 1 < args.length ? [args[i + 1]] : []);
const DIRS = opts('--dir').length ? opts('--dir') : ['C:\\ccode\\test-statements'];
const EXPECTS = opts('--expect');
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

// pdfjs-dist ships ES modules only; the legacy build is the one for Node.
// It is imported at the start of the run (below). It may warn at load time
// about optional canvas/polyfill support that text extraction doesn't need;
// keep the output readable.
let pdfjsLib = null;
async function loadPdfjs() {
  const quiet = (fn) => (...a) => { if (!/Cannot polyfill|canvas|Path2D|DOMMatrix|ImageData/.test(String(a[0]))) fn(...a); };
  const saved = [console.log, console.warn];
  console.log = quiet(saved[0]); console.warn = quiet(saved[1]);
  try {
    pdfjsLib = await import(url.pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  } finally { [console.log, console.warn] = saved; }
}

const TF = loadCore();
const baseLabel = r => `${r.bank} ${r.period ? r.period.to.slice(0, 7) : '?'}`;
// An expectation may instead be keyed by file name (two statements can end in
// the same month); its "alias" (e.g. the statement date) is then printed
// after the label, so file names still never appear in the output.
const aliases = {};
const label = r => baseLabel(r) + (aliases[r.name] ? ` [${aliases[r.name]}]` : '');
let W = 16;
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

function loadFiles(dir) {
  return fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f)).sort().map(f => ({
    name: f, bytes: new Uint8Array(fs.readFileSync(path.join(dir, f))),
    password: process.env.TAXFLOW_PDF_PW || undefined,
  }));
}

(async () => {
  await loadPdfjs();
  const files = [], results = [];
  const expect = EXPECTS.length ? Object.assign({}, ...EXPECTS.map(e => JSON.parse(fs.readFileSync(e, 'utf8')))) : null;
  let expMet = 0, expTotal = 0;
  if (expect) for (const [k, e] of Object.entries(expect)) if (e.alias) { aliases[k] = e.alias; W = 27; }
  for (const [di, dir] of DIRS.entries()) {
    const batch = loadFiles(dir);
    files.push(...batch);
    console.log(`\n== 1. Acceptance${DIRS.length > 1 ? ` (folder ${di + 1} of ${DIRS.length})` : ''}: ${batch.length} PDF(s), text path only, no network ==`);
    const batchResults = await TF.runBatch(batch, baseDeps());
    results.push(...batchResults);
    console.log('statement'.padEnd(W) + ' | rows | row checks | whole stmt | printed totals            | continuity | text/vision | fee convention | ms/page | font decoding');
    for (const r of batchResults) {
      if (r.error) { fail(`a file could not be read: ${r.error}`); continue; }
      const tot = r.whole.printed.map(p => `${p.name}:${p.ok ? 'ok' : 'MISMATCH'}`).join(',') || 'none printed';
      const fm = (Object.values(r.fontModes).includes('encoding') ? 'ToUnicode broken → font encoding' : 'normal') +
      (r.duplicateOf ? ` | DUPLICATE of ${aliases[r.duplicateOf] ? '[' + aliases[r.duplicateOf] + ']' : 'an earlier file'}, ${r.txns.length} txns passed on` : '');
      console.log(`${label(r).padEnd(W)} | ${String(r.rows.length).padStart(4)} | ${(r.rowSummary.passed + '/' + r.rowSummary.total).padStart(10)} | ` +
        `${(r.whole.ok ? 'PASS' : 'FAIL').padEnd(10)} | ${tot.padEnd(25)} | ${r.continuity.status.padEnd(10)} | ` +
        `${(r.counts.text + '/' + r.counts.vision).padEnd(11)} | ${String(r.feeConvention === null ? 'NONE FITS' : r.feeConvention).padEnd(14)} | ` +
        `${(r.ms / r.pages).toFixed(0).padStart(7)} | ${fm}`);
      if (expect) {
        const e = expect[r.name] || expect[baseLabel(r)];
        expTotal++;
        if (!e) fail(`${label(r)}: no expectation`);
        else if (e.rows !== r.rows.length || e.passed !== r.rowSummary.passed || e.whole !== r.whole.ok)
          fail(`${label(r)}: expected ${e.rows} rows, ${e.passed} passed, whole ${e.whole}; got ${r.rows.length}, ${r.rowSummary.passed}, ${r.whole.ok}`);
        else if (e.fee !== undefined && e.fee !== r.feeConvention)
          fail(`${label(r)}: expected fee convention ${e.fee}; got ${r.feeConvention}`);
        else if ((e.duplicateOf || null) !== (r.duplicateOf ? aliases[r.duplicateOf] || '(no alias)' : null))
          fail(`${label(r)}: expected duplicate of ${e.duplicateOf || 'nothing'}; got ${r.duplicateOf ? aliases[r.duplicateOf] || '(no alias)' : 'nothing'}`);
        else if (r.duplicateOf && r.txns.length)
          fail(`${label(r)}: duplicate still passes ${r.txns.length} transactions on`);
        else { expMet++; pass(`${label(r)} matches acceptance (${e.rows} rows, ${e.passed}/${e.rows}, whole ${e.whole ? 'PASS' : 'FAIL'}${e.fee ? ', fees ' + e.fee : ''}` +
          `${r.duplicateOf ? `, duplicate of [${aliases[r.duplicateOf]}], 0 rows passed on` : ''})`); }
      }
    }
  }
  if (expect) console.log(`acceptance: ${expMet}/${expTotal} statement(s) match expectations`);
  const ok = results.filter(r => !r.error);
  const cats = ok.flatMap(r => r.txns);
  const unc = cats.filter(t => t.category === 'Uncategorised').length;
  console.log(`categorised: ${cats.length - unc}/${cats.length} rows matched a keyword rule; ` +
    `${cats.every(t => TF.CATEGORIES.includes(t.category)) ? 'all' : 'NOT all'} categories valid`);

  // ---- 1b. duplicates from an earlier session: renamed copies, by content ----
  console.log('\n== 1b. Duplicates against earlier sessions (in memory) ==');
  {
    const real = ok.filter(r => !r.duplicateOf).slice(0, 2);
    const known = real.map(r => ({ name: r.name, fingerprint: r.fingerprint }));
    const copies = real.map((r, i) => Object.assign({}, files.find(f => f.name === r.name), { name: `renamed-copy-${i + 1}.pdf` }));
    const again = await TF.runBatch(copies, baseDeps({ knownStatements: known }));
    const flagged = again.filter((c, i) => c.duplicateOf === real[i].name && c.txns.length === 0 && c.continuity.status === 'duplicate');
    console.log(`${real.length} statement(s) "committed" earlier, renamed copies uploaded later: ${flagged.length} flagged duplicate, ` +
      `${again.reduce((s, c) => s + c.txns.length, 0)} txns passed on`);
    flagged.length === real.length ? pass('renamed copies of earlier-session statements flagged and excluded') : fail('cross-session duplicates');
    const same = await TF.runBatch([Object.assign({}, files.find(f => f.name === real[0].name))], baseDeps({ knownStatements: known }));
    !same[0].duplicateOf ? pass('re-extracting the same file name is not a duplicate') : fail('same-name re-extract flagged');
  }

  // ---- 1c. bank charges: every fee that reduced the balance, counted once ----
  console.log('\n== 1c. Bank charges (what the dashboard counts) ==');
  console.log('statement'.padEnd(W) + ' | fee conv  | printed fees | Bank Charges | match | spending before → after (fees column ignored → included) | net movement');
  for (const r of ok.filter(x => !x.duplicateOf)) {
    const pf = r.whole.printed.find(p => p.name === 'fees');
    const bc = TF.bankCharges(r.txns);
    const r2 = n => Math.round(n * 100) / 100;
    // before: the dashboard summed row amounts only; after: every app transaction
    const before = r2(-r.rows.reduce((s, x) => s + (x.amount < 0 ? x.amount : 0), 0));
    const after = r2(-r.txns.reduce((s, t) => s + (t.amount < 0 ? t.amount : 0), 0));
    // exactly once: the transactions add up to the same money as the rows (amount + fee)
    const netRows = r2(r.rows.reduce((s, x) => s + x.amount + x.fee, 0));
    const netTxns = r2(r.txns.reduce((s, t) => s + t.amount, 0));
    const match = pf ? Math.abs(pf.printed - bc) < 0.005 : null;
    console.log(`${label(r).padEnd(W)} | ${String(r.feeConvention).padEnd(9)} | ${(pf ? pf.printed.toFixed(2) : 'not printed').padStart(12)} | ` +
      `${bc.toFixed(2).padStart(12)} | ${match === null ? '  -  ' : match ? ' yes ' : ' NO  '} | ${before.toFixed(2)} → ${after.toFixed(2)} | ` +
      `${netRows === netTxns ? 'same' : 'DIFFERENT'} (${netTxns.toFixed(2)})`);
    if (match === false) fail(`${label(r)}: Bank Charges ${bc.toFixed(2)} ≠ printed fee total ${pf.printed.toFixed(2)}`);
    if (netRows !== netTxns) fail(`${label(r)}: transactions move ${netTxns.toFixed(2)}, rows move ${netRows.toFixed(2)} — a fee is double counted or lost`);
  }
  {
    const withTotal = ok.filter(x => !x.duplicateOf && x.whole.printed.some(p => p.name === 'fees'));
    console.log(`bank charges = printed fee total on ${withTotal.filter(x => Math.abs(x.whole.printed.find(p => p.name === 'fees').printed - TF.bankCharges(x.txns)) < 0.005).length}/${withTotal.length} statement(s) with a printed fee total`);
  }

  // ---- 1d. categorisation baseline: counts only, never merchant names ----
  console.log('\n== 1d. Categorisation baseline (rows, counts only) ==');
  {
    const stmts = ok.filter(x => !x.duplicateOf).slice().sort((a, b) => (a.period.from || '').localeCompare(b.period.from || ''));
    const rows = stmts.flatMap(x => x.rows);
    const ruled = rows.filter(x => TF.categorise(x.reference) !== 'Uncategorised').length;
    const keys = rows.map(x => TF.merchantKey(x.reference));
    const uniq = new Set(keys.filter(Boolean));
    const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '-';
    console.log(`rows ${rows.length} | rules alone categorise ${ruled} (${pct(ruled, rows.length)}) | ` +
      `unique merchant keys ${uniq.size} | rows with no key ${keys.filter(k => !k).length}`);
    // memory potential: statements in date order; a row "hits" if its key was seen in an EARLIER statement
    const seen = new Set();
    const per = [];
    for (const st of stmts) {
      const ks = st.rows.map(x => TF.merchantKey(x.reference));
      const hit = ks.filter(k => k && seen.has(k)).length;
      per.push({ month: st.period.from.slice(0, 7), bank: st.bank, rows: ks.length, hit });
      ks.forEach(k => { if (k) seen.add(k); });
    }
    per.forEach(p => console.log(`  ${p.month} ${p.bank.padEnd(8)} | ${String(p.rows).padStart(4)} rows | key seen in an earlier statement: ${String(p.hit).padStart(4)} (${pct(p.hit, p.rows)})`));
    const later = per.slice(1);
    const avg = later.length ? later.reduce((s, p) => s + p.hit / p.rows, 0) / later.length : 0;
    const pooled = later.reduce((s, p) => s + p.hit, 0) / Math.max(1, later.reduce((s, p) => s + p.rows, 0));
    console.log(`memory potential (statements 2..${per.length}): average ${(100 * avg).toFixed(1)}% per statement, ${(100 * pooled).toFixed(1)}% of their rows`);
  }

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
    console.log(`${label(r).padEnd(W)} | A amount+R1: ${sa.failed} row fail, whole ${wa.balanceOk ? 'pass' : 'FAIL'}` +
      ` | B middle row deleted: ${sb.failed} row fail, whole ${wb.balanceOk ? 'pass' : 'FAIL'}` +
      ` | C last row deleted: whole ${wc.balanceOk ? 'pass' : 'FAIL'}, continuity vs next statement ${follower.continuity.status}` +
      ` → ${cCaught ? 'caught' : 'MISSED'} (${r.closingSource === 'printed' ? 'printed closing balance' : 'continuity only'})`);
    if (sa.failed !== 1 || wa.balanceOk) fail(`${label(r)} sabotage A not caught`);
    if (sb.failed !== 1 || wb.balanceOk) fail(`${label(r)} sabotage B not caught`);
    if (!cCaught) fail(`${label(r)} sabotage C not caught`);
  }

  // ---- 2b. fee convention: chosen for the whole statement, never row by row ----
  console.log('\n== 2b. Fee convention sabotage (in memory) ==');
  for (const r of ok) {
    const feeRows = r.rows.map((x, i) => x.feeCol ? i : -1).filter(i => i >= 0);
    if (!feeRows.length || !['separate', 'included'].includes(r.feeConvention)) {
      console.log(`${label(r).padEnd(W)} | convention ${r.feeConvention === null ? 'NONE FITS' : r.feeConvention}: no Fees-column rows to sabotage`);
      continue;
    }
    const other = r.feeConvention === 'separate' ? 'included' : 'separate';
    // D: the other convention, applied to the whole statement, must not balance
    const d = clone(r.rows); TF.applyFeeConvention(d, other);
    const sd = TF.checkRows(r.opening, d);
    // E: one fee row rewritten to follow the other convention (its balance and
    // every later balance shifted by its fee) → no single convention may fit
    const e = clone(r.rows);
    const at = feeRows[Math.floor(feeRows.length / 2)];
    const shift = r.feeConvention === 'separate' ? -e[at].feeCol : e[at].feeCol;
    for (let j = at; j < e.length; j++) if (e[j].balance !== null) e[j].balance = Math.round((e[j].balance + shift) * 100) / 100;
    const ce = TF.chooseFeeConvention(r.opening, e);
    const se = TF.checkRows(r.opening, e);
    console.log(`${label(r).padEnd(W)} | chosen ${r.feeConvention}, ${feeRows.length} Fees-column row(s) | D whole statement as ${other}: ${sd.failed} row fail` +
      ` | E one row mixed: chooser → ${ce.convention === null ? 'none fits' : ce.convention} (tried ${ce.tried.map(t => t.convention + ' ' + t.failed + ' fail').join(', ')}), ${se.failed} row fail`);
    if (sd.failed < 1) fail(`${label(r)} sabotage D: other convention also balances`);
    if (feeRows.length > 1 && (ce.convention !== null || se.failed < 1)) fail(`${label(r)} sabotage E: mixed conventions not flagged`);
  }

  // ---- 3. continuity: synthetic consecutive statement ----
  console.log('\n== 3. Continuity ==');
  for (const r of ok) console.log(`${label(r).padEnd(W)} | ${r.continuity.status}${r.continuity.months ? ' (' + r.continuity.months + ' month(s) missing)' : ''}`);
  {
    const brk = ok.filter(r => r.continuity.status === 'break');
    brk.length ? fail(`${brk.length} continuity break(s) in the real statements`) : pass('no continuity breaks (duplicates skipped)');
  }
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
  // one statement per bank and per fee convention (the one with the most pages)
  const targets = [...new Set(['bank', 'feeConvention'].flatMap(k => Object.values(ok.filter(r => !r.duplicateOf)
    .reduce((m, r) => { if (!m[r[k]] || r.pages > m[r[k]].pages) m[r[k]] = r; return m; }, {}))))];
  for (const target of targets) {
    const file = files.find(f => f.name === target.name);
    const truth = {};
    target.rows.forEach(r => { (truth[r.page] = truth[r.page] || []).push(r); });
    // What the vision prompt asks for: figures as printed — the amount
    // (fee-marked debits included), the raw Fees-column value, the fee mark.
    const asVision = (rows) => ({ transactions: rows.map(r => ({
      post_date: r.iso, reference: r.reference, amount: r.amount,
      fees_column: r.feeCol ? Math.abs(r.feeCol) : null, fee_marked: !!r.star, balance: r.balance })) });
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
    console.log(`using ${label(target)} (${target.pages} pages, transactions on pages ${txnPages.join(',')}, fee convention ${target.feeConvention})`);

    { // 4a: every transaction page forced to vision: parallelism + retry
      const m = mock({ failFirst: [txnPages[1]] });
      const res = await TF.processFile(file, baseDeps({ renderPageImage: m.renderPageImage, callVision: m.callVision, forceVisionPages: new Set(txnPages) }));
      console.log(`4a all txn pages via vision: max ${m.st.max} calls in flight, calls per page ${JSON.stringify(m.st.calls)}, ` +
        `rows ${res.rows.length}, ${res.rowSummary.passed}/${res.rowSummary.total} verified, text/vision ${res.counts.text}/${res.counts.vision}, status ${res.status}`);
      m.st.max <= 3 && m.st.max > 1 ? pass('vision runs in parallel, at most 3 at a time') : fail(`concurrency ${m.st.max}`);
      m.st.calls[txnPages[1]] === 2 && Object.entries(m.st.calls).every(([p, n]) => +p === txnPages[1] || n === 1)
        ? pass('failed page retried once on its own; no other page re-sent') : fail('retry behaviour');
      res.status === 'reconciled' && res.counts.vision === target.rows.length ? pass('vision rows went through the balance checks and reconciled') : fail('4a reconcile');
      res.feeConvention === target.feeConvention && Math.abs(TF.bankCharges(TF.rowsToTxns(res)) - TF.bankCharges(target.txns)) < 0.005
        ? pass(`vision rows chose the same fee convention (${res.feeConvention}) and the same bank charges as text`)
        : fail(`4a fee convention via vision: ${res.feeConvention} vs ${target.feeConvention}`);
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
