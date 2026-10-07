#!/usr/bin/env node
/* Unit tests for TF.merchantKey (the merchant-key normaliser in tf-core).
   Examples are made up in the shapes South African statements print —
   no real statement lines. No network.
     node tests/merchant-key.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
vm.runInThisContext(html.match(/<script id="tf-core">([\s\S]*?)<\/script>/)[1]);
const key = globalThis.TF.merchantKey;

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'} ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`);
};
const is = (ref, want) => { const got = key(ref); check(`${JSON.stringify(ref)} → ${JSON.stringify(want)}`, got === want, got); };
const same = (a, b) => { const ka = key(a), kb = key(b); check(`same merchant: ${JSON.stringify(a)} ≡ ${JSON.stringify(b)}`, ka !== null && ka === kb, `${ka} | ${kb}`); };
const differ = (a, b) => { const ka = key(a), kb = key(b); check(`different merchants stay apart: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`, ka !== kb, `${ka} | ${kb}`); };

console.log('== shapes ==');
is('POS Local Purchase 4000123412341234 WOOLWORTHS JOHANNESBURG AUTH ID 123456', 'WOOLWORTHS');
is('WOOLWORTHS 400012XXXXXX9876', 'WOOLWORTHS');
is('CHECKERS SANDT400012XXXXXX9876', 'CHECKERS SANDT');                        // card number glued to a truncated name
is('POS Local Purchase 4000123412341234 Spar Greenside Gauteng Sout AUTHID 654321', 'SPAR GREENSIDE');
is('POS Local Purchase 4000123412341234 CHECKERS HYPER CAPE TOWNAUTH ID 112233', 'CHECKERS HYPER');   // AUTH glued to the city
is('Fuel Purchase 4000123412341234 ENGEN MELVILLE Johannesburg AUTH ID 998877', 'ENGEN MELVILLE');
is('C*NANDOS ROSEBANK400012XXXXXX9876', 'NANDOS ROSEBANK');                  // card-processor prefix
is('FLW*UBER TRIPS Johannesburg AUTH ID 123456', 'UBER TRIPS');
is('PAYPAL *NETFLIX 400012XXXXXX9876', 'NETFLIX');
is('NETFLIX.COM 400012XXXXXX9876', 'NETFLIX');
is('POS Local Purchase 4000123412341234 https://www.uber.com/za CAPE TOWNAUTH ID 123456', 'UBER');      // URL, country and glued city all go
is('Debit Order DISCOVERY LIFE 0012345678 POL998877A', 'DISCOVERY LIFE');      // reference codes dropped
is('Debit Order TELKOM MOBILE 12CLI3456789TRK0001', 'TELKOM MOBILE');
is('ACMEINSURE01234567890123', 'ACMEINSURE');                                  // name glued to a long number
is('Outward EFT ACME ACCOUNTING INV2024 To 1234567890 123456', 'ACME ACCOUNTING TO');
is('SERVICE FEE 05/24 - 06/24', 'SERVICE FEE');                                // dates
is('Salary ACME CORP DEC 23', 'SALARY ACME CORP');                             // month + year
is('Card purchase 14 Mar 2024 12:31 TAKEALOT', 'TAKEALOT');                    // date and time
is('DEBIT ORDER FEE', 'DEBIT ORDER FEE');                                      // never reduced to just "FEE"
is('ACME TRADING PTY LTD', 'ACME TRADING');
is('NICE ON 9TH 400012XXXXXX9876', 'NICE ON 9TH');                             // ordinals stay
is('CITY OF JOHANNESBURG', 'CITY OF JOHANNESBURG');                            // a place that IS the merchant stays
is('ATM CASH 400012XXXXXX9876', 'CASH');
is('', null);
is('400012XXXXXX9876 123456', null);

console.log('\n== same merchant, different statements / formats ==');
same('POS Local Purchase 4000123412341234 WOOLWORTHS JOHANNESBURG AUTH ID 123456', 'WOOLWORTHS 400012XXXXXX9876');
same('Uber 400012XXXXXX9876', 'POS Local Purchase 4000123412341234 Uber CAPE TOWN AUTH ID 123456');
same('Debit Order DISCOVERY LIFE 0012345678 POL998877A', 'Debit Order DISCOVERY LIFE 0099999999 POL123456B');
same('Salary ACME CORP DEC 23', 'SALARY ACME CORP JAN 24');

console.log('\n== similar but different merchants never merge ==');
differ('UBER 400012XXXXXX9876', 'UBER EATS 400012XXXXXX9876');                 // ride vs food delivery
differ('MR PRICE 400012XXXXXX9876', 'MR PRICE HOME 400012XXXXXX9876');
differ('SHELL 400012XXXXXX9876', 'SHELLEYS 400012XXXXXX9876');
differ('BP 400012XXXXXX9876', 'BPS 400012XXXXXX9876');
differ('POS Local Purchase 4000123412341234 SPAR GREENSIDE AUTH ID 1', 'POS Local Purchase 4000123412341234 SPAR PARKHURST AUTH ID 2');
differ('Debit Order DISCOVERY LIFE 0012345678', 'Debit Order DISCOVERY HEALTH 0012345678');

console.log('\n== privacy: no numbers survive ==');
const samples = ['POS Local Purchase 4000123412341234 WOOLWORTHS AUTH ID 123456', 'Outward EFT ACME To 1234567890 123456',
  'Debit Order ACME 0012345678 POL998877A', 'ACMEINSURE01234567890123', 'Send money +27821234567'];
check('no key keeps a run of 2+ digits', samples.every(r => !/\d{2,}/.test(key(r) || '')), samples.map(key).join(' | '));
check('every key is at most 120 characters', [key('A '.repeat(200))].every(k => k.length <= 120));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL MERCHANT KEY CHECKS PASSED');
process.exit(failures ? 1 : 0);
