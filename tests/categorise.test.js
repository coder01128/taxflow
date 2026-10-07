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

(async () => {
  console.log('\n== AI suggestions (mocked AI) ==');
  const rows = () => {
    const t = [
      tx('POS Local Purchase 4000123412341234 ZEBRA GADGETS SANDTON AUTH ID 123456', { amount: -1234.56 }),
      tx('ZEBRA GADGETS 400012XXXXXX9876', { amount: -99.99 }),           // same merchant: asked once
      tx('QUOKKA STUDIO 400012XXXXXX9876', { amount: -250 }),
      tx('PANGOLIN PRINTS 400012XXXXXX9876', { amount: -80 }),
      tx('WOOLWORTHS FOOD 400012XXXXXX9876'),                               // rule → never asked
      tx('ACME DELI 400012XXXXXX9876'),                                     // confirmed memory → never asked
      tx('Immediate Payment J Smith rent', { amount: -9500 }),              // payment to a person → never asked
      tx('Send money +27821234567', { amount: -300 }),                      // transfer → never asked
      tx('Outward EFT ACME ACCOUNTING To 1234567890 123456'),               // EFT to someone → never asked
      tx('Mr T Ndlovu', { amount: 1500 }),                                  // looks like a person → never asked
      tx('Lee', { amount: -500 }),                                          // one typed word, no card marker → could be a name
      tx('Bank fee: ZEBRA GADGETS', { category: 'Bank Charges', bank_fee: true }),
    ];
    return t;
  };
  const memory = () => ({ 'ACME DELI': { category: 'Dining Out', source: 'confirmed', times: 1 } });

  // 1. what would be sent
  {
    const t = rows(), mem = memory();
    TF.applyCategories(t, mem, []);
    const sent = [];
    await TF.suggestCategories(t, mem, async (keys) => { sent.push(keys); return { suggestions: {} }; }, []);
    const payload = JSON.stringify({ keys: sent[0] });
    check('exactly one batched call for the run', sent.length === 1, sent.length);
    check('only unseen, unruled, non-private merchant keys are sent', JSON.stringify(sent[0]) === JSON.stringify(['PANGOLIN PRINTS', 'QUOKKA STUDIO', 'ZEBRA GADGETS']), JSON.stringify(sent[0]));
    check('payload carries no amounts, dates, numbers or raw references', !/\d/.test(payload) && !/POS|AUTH|XXXX|2026|1234|99\.99/.test(payload), payload);
    check('transfers / payments to people go straight to Needs review', t.slice(6, 11).every(x => x.private && x.cat_source === 'review'));
  }
  // 2. answers: high → AI suggestion, low → Needs review with a hint, invalid → Needs review
  {
    const t = rows(), mem = memory();
    TF.applyCategories(t, mem, []);
    const r = await TF.suggestCategories(t, mem, async () => ({ suggestions: {
      'ZEBRA GADGETS': { category: 'Home & Maintenance', confidence: 'high' },
      'QUOKKA STUDIO': { category: 'Entertainment', confidence: 'low' },
      'PANGOLIN PRINTS': { category: 'Made Up Category', confidence: 'high' },
    } }), []);
    check('high confidence → AI suggestion on every row of that merchant', t[0].cat_source === 'ai' && t[1].cat_source === 'ai' && t[0].category === 'Home & Maintenance');
    check('low confidence → Needs review, suggestion shown as a hint only', t[2].cat_source === 'review' && t[2].category === 'Uncategorised' && t[2].ai_hint === 'Entertainment');
    check('a category outside the fixed list is rejected → Needs review', t[3].cat_source === 'review' && !t[3].ai_hint);
    check('answers are remembered, so nothing is asked twice', TF.aiCandidates(t, mem).length === 0 && r.answered === 2, r.answered);
    check('rule, confirmed and bank-fee rows untouched', t[4].cat_source === 'rule' && t[5].cat_source === 'confirmed' && t[11].category === 'Bank Charges');
    // a human confirmation then wins over the AI suggestion for that merchant
    TF.confirmCategory(t, t[0], 'Entertainment', mem);
    check('a human correction overrides the AI suggestion on the same merchant', t[1].category === 'Entertainment' && t[1].cat_source === 'confirmed');
  }
  // 3. failure and opened-from-disk: nothing breaks, rows stay Needs review
  {
    const t = rows(), mem = memory();
    TF.applyCategories(t, mem, []);
    const r = await TF.suggestCategories(t, mem, async () => { throw new Error('mock HTTP 502'); }, []);
    check('AI call fails → error reported, rows stay Needs review', r.error === 'mock HTTP 502' && t[0].cat_source === 'review' && t[2].cat_source === 'review');
    check('a failed call is not remembered (asked again next run)', TF.aiCandidates(t, mem).length === 3);
    const off = await TF.suggestCategories(t, mem, null, []);
    check('no AI available (opened from disk) → not called, rows stay Needs review', off.offline && off.calls === 0 && t[0].cat_source === 'review');
  }
  // 4. more than 200 new merchants → requests of at most 200 keys
  {
    const many = Array.from({ length: 450 }, (_, i) => tx('MERCHANT ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26] + ' ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(i / 26) % 26]));
    TF.applyCategories(many, {}, []);
    const sizes = [];
    await TF.suggestCategories(many, {}, async (keys) => { sizes.push(keys.length); return { suggestions: {} }; }, []);
    check('450 new merchants → 3 requests of at most 200', JSON.stringify(sizes) === '[200,200,50]', JSON.stringify(sizes));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CATEGORISATION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
