#!/usr/bin/env node
/* One-click balance correction (TF.balanceOffers / statementChecks /
   recheckLite). No network: vision is MOCKED.
     node tests/correction.test.js [--image <image-only sample pdf>] [--bad <bad-balance pdf>]
   Defaults point at the lab folder (kept outside the repo):
     C:\ccode\taxflow-lab\vision-test\sample-image-only.pdf  — image-only copy of samples/sample-statement.pdf
     C:\ccode\taxflow-lab\synthetic\bad-balance.pdf          — a statement whose printed balance is wrong */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const url = require('url');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IMAGE = opt('--image', 'C:\\ccode\\taxflow-lab\\vision-test\\sample-image-only.pdf');
const BAD = opt('--bad', 'C:\\ccode\\taxflow-lab\\synthetic\\bad-balance.pdf');
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/<script id="tf-core">([\s\S]*?)<\/script>/)[1]);
const TF = globalThis.TF;

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'} ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`);
};
const r2 = n => Math.round(n * 100) / 100;

(async () => {
  console.log('== unit ==');
  {
    const rows = () => [
      { amount: -100, fee: 0, balance: 900 }, { amount: -50, fee: 0, balance: 850 },
      { amount: -20, fee: -2, balance: 828 }, { amount: 300, fee: 0, balance: 1128 }, { amount: -28, fee: 0, balance: 1100 },
    ];
    let r = rows(); r[1].amount = -55;                       // misread amount, isolated
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('isolated misread amount → offered the balance-implied amount', r[1].offer === -50 && r.filter(x => x.offer !== null).length === 1, r[1].offer);
    r = rows(); r[2].amount = -25;                            // fee row: implied amount nets the fee off
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('fee convention applied: implied amount = balance − previous − fee', r[2].offer === -20, r[2].offer);
    r = rows(); r[0].amount = -110;                           // first row: previous is the opening balance
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('first row uses the opening balance as "previous"', r[0].offer === -100, r[0].offer);
    r = rows(); r[1].balance = 860;                           // printed balance itself wrong → this and the next row fail
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('wrong printed balance → no offer anywhere', r.every(x => x.offer === null), r.map(x => x.offer).join(','));
    r = rows(); r[1].amount = -55; r[2].amount = -30;         // two neighbouring errors → not isolated
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('neighbouring errors → no offer for the first (next row fails)', r[1].offer === null, r[1].offer);
    r = rows(); r[4].amount = -30;                            // last row: no next row to confirm it
    TF.checkRows(1000, r); TF.balanceOffers(1000, r);
    check('last row → not offered (nothing after it confirms the printed balance)', r[4].offer === null);
  }

  // pdf.js (legacy ESM build) for the PDF cases
  const pdfjsLib = await import(url.pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const deps = (extra) => Object.assign({ pdfjsLib, docOptions: { disableFontFace: true, verbosity: 0 },
    renderPageImage: async () => 'MOCKJPEG', callVision: async () => { throw new Error('vision disabled'); } }, extra || {});
  const open = (file) => ({ name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) });

  console.log('\n== image-only sample, salary misread by mocked vision ==');
  if (!fs.existsSync(IMAGE)) { check(`image-only sample present (${IMAGE})`, false); }
  else {
    // the truth: the text-layer sample in the repo
    const truth = await TF.processFile(open(path.join(ROOT, 'samples', 'sample-statement.pdf')), deps());
    const salary = truth.rows.findIndex(r => r.amount === 28500);
    const visionCalls = [];
    const callVision = async (img, ctx) => {
      visionCalls.push(ctx.page);
      const rows = truth.rows.filter(r => r.page === ctx.page);
      return {
        opening_balance: ctx.page === 1 ? truth.opening : null,
        transactions: rows.map(r => ({ post_date: r.iso, reference: r.reference,
          amount: r === truth.rows[salary] ? 28580.40 : r.amount,           // the misread
          fees_column: null, fee_marked: false, balance: r.balance })),
      };
    };
    const res = await TF.processFile(open(IMAGE), deps({ callVision }));
    const offered = res.rows.filter(r => r.offer !== null && r.offer !== undefined);
    check('every page went to vision (no text layer)', res.counts.text === 0 && res.counts.vision === truth.rows.length, `${res.counts.text}/${res.counts.vision}`);
    check('the misread salary row fails the balance check', res.rows[salary].ok === false && res.rowSummary.failed === 1, res.rowSummary.failed);
    check('exactly one offer, and it is exactly R28,500.00', offered.length === 1 && offered[0] === res.rows[salary] && offered[0].offer === 28500,
      offered.map(r => r.offer).join(','));
    // accept → re-run every check from the saved numbers, as the app does
    const lite = TF.liteRows(res.rows);
    lite[salary].a = lite[salary].o; lite[salary].c = { from: 28580.40, to: lite[salary].o, how: 'balance-implied' };
    const re = TF.recheckLite(res.opening, lite, res.closingPrinted, res.totals, []);
    check('after accepting: every row balances and the statement reconciles', re.rowSummary.passed === truth.rows.length && re.status === 'reconciled',
      `${re.rowSummary.passed}/${re.rowSummary.total} ${re.status}`);
    check('the correction is recorded on the row', re.lite[salary].c && re.lite[salary].c.how === 'balance-implied');
    const txns = TF.rowsToTxns(Object.assign({}, res, { rows: res.rows }));
    check('the offer reaches the row\'s transaction (shown in Review)', txns.find(t => t.row === salary && t.main).offer === 28500);
  }

  console.log('\n== a printed balance that is itself wrong (bad-balance file) ==');
  if (!fs.existsSync(BAD)) { check(`bad-balance file present (${BAD})`, false); }
  else {
    const res = await TF.processFile(open(BAD), deps());
    check('the bad-balance file still flags 2 rows', res.rowSummary.failed === 2, res.rowSummary.failed);
    check('no correction is offered for either row', res.rows.every(r => r.offer === null || r.offer === undefined),
      res.rows.map(r => r.offer).join(','));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CORRECTION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
