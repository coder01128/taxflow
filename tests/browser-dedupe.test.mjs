#!/usr/bin/env node
/* Browser test (headless Chrome over the DevTools protocol, Node's built-in
   WebSocket — no npm packages, no network apart from the pdf.js CDN):
   "Remove Source" must also forget the statement's fingerprint, so
   uploading it again later is not flagged as a duplicate.
   Uses only the app's built-in synthetic sample.
     node tests/browser-dedupe.test.mjs [--chrome <path to chrome.exe>] [--url <app url>] */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CHROME = opt('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const APP = opt('--url', url.pathToFileURL(path.join(ROOT, 'index.html')).href);

const EXPR = `(async () => {
  await window.pdfjsReady;
  const steps = {};
  const sample = () => { const b = atob(SAMPLE_PDF_B64); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const status = (name) => { const r = AppState.reconResults.find(x => x.name === name); return r ? (r.duplicateOf ? 'duplicate of ' + r.duplicateOf : r.status) : 'none'; };
  // 1. extract the statement, then commit it
  AppState.unlockedFiles.push({ name: 'statement-a.pdf', bytes: sample(), pages: 2 });
  await Extractor.run();
  const committed = Review.commit(); await new Promise(r => setTimeout(r, 150));
  const go = [...document.querySelectorAll('.tf-modal button')].find(b => b.textContent === 'Commit anyway'); if (go) go.click();
  await committed;
  steps.first = status('statement-a.pdf');
  // 2. a renamed copy is a duplicate (sanity)
  AppState.unlockedFiles.push({ name: 'statement-copy.pdf', bytes: sample(), pages: 2 });
  await Extractor.run();
  steps.copyBeforeRemove = status('statement-copy.pdf');
  // 3. Remove Source for the original (its confirm and alert are accepted by the driver)
  App.goto('review'); Review.render();
  const sel = document.getElementById('rv-source-filter'); sel.value = 'statement-a.pdf';
  Review.removeSource();
  steps.reviewRowsAfterRemove = AppState.reviewData.length;
  steps.knownAfterRemove = AppState.knownStatements.map(k => k.name);
  steps.committedKnownAfterRemove = (AppState.committedData.metadata.statements || []).map(k => k.name);
  // 4. upload it again under a new name: must NOT be a duplicate any more
  AppState.unlockedFiles = AppState.unlockedFiles.filter(f => f.name !== 'statement-copy.pdf');
  AppState.unlockedFiles.push({ name: 'statement-again.pdf', bytes: sample(), pages: 2 });
  await Extractor.run();
  steps.reuploadAfterRemove = status('statement-again.pdf');
  steps.reviewRowsAfterReupload = AppState.reviewData.length;
  return steps;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let failures = 0;
const check = (label, cond, extra) => { if (!cond) failures++; console.log(`${cond ? 'pass' : 'FAIL'} ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`); };
const finish = (code) => { try { chrome.kill(); } catch (e) { /* gone */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked */ } process.exit(code); };
setTimeout(() => { console.log('TIMEOUT'); finish(2); }, 150000);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* starting */ }
}
if (!target) { console.log('Chrome did not start (pass --chrome <path>)'); finish(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = {}; const errors = [];
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; return; }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: APP });
await sleep(4000);
const res = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
const s = res.result?.result?.value;
if (!s) { console.log('evaluation failed', JSON.stringify(res.result?.exceptionDetails || res).slice(0, 400)); finish(2); }
console.log(JSON.stringify(s));
check('the statement extracts and commits', s.first === 'reconciled', s.first);
check('a renamed copy is flagged as a duplicate while the original is known', s.copyBeforeRemove === 'duplicate of statement-a.pdf', s.copyBeforeRemove);
check('Remove Source removes its rows', s.reviewRowsAfterRemove === 0, s.reviewRowsAfterRemove);
check('Remove Source forgets its fingerprint (known statements)', !s.knownAfterRemove.includes('statement-a.pdf'), s.knownAfterRemove.join(','));
check('… and in the committed data', !s.committedKnownAfterRemove.includes('statement-a.pdf'), s.committedKnownAfterRemove.join(','));
check('uploading it again is NOT flagged as a duplicate', s.reuploadAfterRemove === 'reconciled', s.reuploadAfterRemove);
check('its rows are back in Review', s.reviewRowsAfterReupload === 30, s.reviewRowsAfterReupload);
check('no page errors', !errors.length, errors.join(' | '));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BROWSER DEDUPE CHECKS PASSED');
finish(failures ? 1 : 0);
