const fs = require('fs');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.error('jsdom not found. Install it once with:  npm i jsdom  (from the tests/ folder)');
  process.exit(3);
}
const html = fs.readFileSync(process.argv[2], 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://local/' });
const w = dom.window;
w.fetch = () => Promise.reject(new Error('no network in test'));
w.confirm = () => true; w.alert = () => {}; w.scrollTo = () => {};

/* jsdom has no layout, so it implements no scrolling at all: `scrollTo` is
   missing entirely, and assigning `scrollTop` stores the number but never
   fires a `scroll` event. The date drums are driven ENTIRELY by scroll
   events, so without emulating this the picker can't be tested — and the
   "range resets on reopen" bug in particular is invisible, because it is
   triggered by a programmatic scrollTop assignment.

   These two shims make jsdom behave like a browser for that pipeline:
   assigning scrollTop fires `scroll`, and scrollTo() assigns scrollTop.
   Behaviour:'smooth' is applied instantly, which only removes a delay. */
const elProto = w.Element.prototype;
const stDesc = Object.getOwnPropertyDescriptor(elProto, 'scrollTop');
Object.defineProperty(elProto, 'scrollTop', {
  configurable: true,
  get() { return stDesc.get.call(this); },
  set(v) {
    stDesc.set.call(this, v);
    this.dispatchEvent(new w.Event('scroll'));
  },
});
elProto.scrollTo = function (opts, y) {
  const top = (opts && typeof opts === 'object') ? opts.top : y;
  if (typeof top === 'number') this.scrollTop = top;
};
elProto.scrollIntoView = function () {};
w['pdfjs-dist/build/pdf'] = { GlobalWorkerOptions:{}, getDocument: () => ({promise: Promise.resolve({numPages:0})}) };
w.PDFLib = {}; w.ExcelJS = {};
let n = 0;
const iv = setInterval(() => {
  if (w.__done) {
    clearInterval(iv);
    const r = w.__results;
    let fail = 0;
    r.forEach(x => { if (!x.pass) fail++; console.log((x.pass?'PASS ':'FAIL ') + x.label + (x.extra? '  ['+x.extra+']':'')); });
    console.log(`\n${r.length - fail}/${r.length} passed`);
    process.exit(fail ? 1 : 0);
  }
  if (++n > 150) { clearInterval(iv); console.log('TIMEOUT'); console.log((w.__err||'')); process.exit(2); }
}, 100);
