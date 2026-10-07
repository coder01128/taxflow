#!/usr/bin/env node
/* Categorisation tests: precedence (confirmed memory → rule → AI → needs
   review), merchant memory, one-click propagation, and the AI suggestion
   flow with a MOCKED AI (no network, no cost). Made-up references only.
     node tests/categorise.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
vm.runInThisContext(html.match(/<script id="tf-core">([\s\S]*?)<\/script>/)[1]);
const TF = globalThis.TF;

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'} ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`);
};
let n = 0;
const tx = (reference, extra) => Object.assign({ id: 't' + (++n), reference, amount: -100, post_date: '2026-01-01' }, extra || {});

console.log('== precedence ==');
{
  const memory = { 'ACME DELI': { category: 'Dining Out', source: 'confirmed', times: 1 },
    'CHECKERS': { category: 'Entertainment', source: 'confirmed', times: 2 },
    'ZEBRA GADGETS': { category: 'Home & Maintenance', source: 'ai', confidence: 'high', times: 0 },
    'QUOKKA STUDIO': { category: 'Entertainment', source: 'ai', confidence: 'low', times: 0 } };
  const t = [
    tx('ACME DELI 400012XXXXXX9876'),                 // confirmed memory, no rule
    tx('POS Local Purchase 4000123412341234 CHECKERS AUTH ID 1'),   // memory beats the Groceries rule
    tx('WOOLWORTHS FOOD 400012XXXXXX9876'),           // rule
    tx('ZEBRA GADGETS 400012XXXXXX9876'),             // AI high
    tx('QUOKKA STUDIO 400012XXXXXX9876'),             // AI low → needs review + hint
    tx('UNHEARD OF PLACE 400012XXXXXX9876'),          // nothing
    tx('Bank fee: ACME DELI', { category: 'Bank Charges', bank_fee: true }),   // statement-marked fee
  ];
  TF.applyCategories(t, memory, []);
  const got = t.map(x => `${x.category}/${x.cat_source}${x.ai_hint ? '(' + x.ai_hint + ')' : ''}`);
  check('confirmed memory → Confirmed', got[0] === 'Dining Out/confirmed', got[0]);
  check('confirmed memory beats a keyword rule', got[1] === 'Entertainment/confirmed', got[1]);
  check('keyword rule → Rule', got[2] === 'Groceries/rule', got[2]);
  check('high-confidence AI → AI suggestion', got[3] === 'Home & Maintenance/ai', got[3]);
  check('low-confidence AI → Needs review, suggestion kept as a hint only', got[4] === 'Uncategorised/review(Entertainment)', got[4]);
  check('nothing known → Needs review', got[5] === 'Uncategorised/review', got[5]);
  check('bank fee stays Bank Charges (Rule), no merchant key, memory ignored', got[6] === 'Bank Charges/rule' && t[6].merchant_key === null, got[6]);
  const before = t[0].category;
  TF.applyCategories(t, { 'ACME DELI': { category: 'Groceries', source: 'confirmed', times: 1 } }, []);
  check('a Confirmed row is never re-categorised by a later pass', t[0].category === before);
}

console.log('\n== one-click correction → memory + same-merchant rows ==');
{
  const memory = {};
  const data = [
    tx('POS Local Purchase 4000123412341234 ZEBRA GADGETS AUTH ID 1'),
    tx('ZEBRA GADGETS 400012XXXXXX1111'),
    tx('ZEBRA GADGETS 400012XXXXXX2222'),
    tx('ZEBRA GADGETS 400012XXXXXX3333'),
    tx('ZEBRA GADGETS EXPRESS 400012XXXXXX3333'),   // a different merchant
  ];
  TF.applyCategories(data, memory, []);
  Object.assign(data[3], { category: 'Entertainment', cat_source: 'confirmed' });   // a human set this row on its own earlier
  const changed = TF.confirmCategory(data, data[0], 'Home & Maintenance', memory);
  check('memory saved as Confirmed', memory['ZEBRA GADGETS'] && memory['ZEBRA GADGETS'].source === 'confirmed' &&
    memory['ZEBRA GADGETS'].category === 'Home & Maintenance', JSON.stringify(memory['ZEBRA GADGETS']));
  check('applied to the 2 other unconfirmed rows from this merchant', changed.length === 2 &&
    data[1].category === 'Home & Maintenance' && data[2].category === 'Home & Maintenance', changed.length);
  check('another human-confirmed row is never overwritten', data[3].category === 'Entertainment' && data[3].cat_source === 'confirmed');
  check('a different merchant is untouched', data[4].cat_source === 'review');
  TF.confirmCategory(data, data[1], 'Home & Maintenance', memory);
  check('times confirmed counts human confirmations', memory['ZEBRA GADGETS'].times === 2, memory['ZEBRA GADGETS'].times);
  const later = [tx('ZEBRA GADGETS 400012XXXXXX9999')];
  TF.applyCategories(later, memory, []);
  check('a later statement picks the merchant up from memory as Confirmed', later[0].category === 'Home & Maintenance' && later[0].cat_source === 'confirmed');
  const fee = tx('Bank fee: ZEBRA GADGETS', { category: 'Bank Charges', bank_fee: true });
  TF.applyCategories([fee], memory, []);
  check('memory never touches a bank fee', fee.category === 'Bank Charges');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CATEGORISATION CHECKS PASSED');
process.exit(failures ? 1 : 0);
