'use strict';
// The online demo (a plain browser tab, display-mode: browser) in a real Edge (headless): no real folder
// access, just the ~10 sample folders of demo-data/. Confirms the demo screen appears instead of the real
// picker, that search/full-text/duplicate-detection work against the virtual folder, that manifest.json and
// sw.js are valid and same-origin, and that no request leaves the page's own origin.
// Run: node tests/e2e-demo.js   (skipped when Edge is not installed)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { closeEdge } = require('./edge-close.js');
const ROOT = path.join(__dirname, '..');
let fails = 0;
const t = (name, ok, extra) => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra || ''); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => fs.existsSync(p));
if (!EDGE) { console.log('PASS Edge is not installed: the browser test is skipped'); process.exit(0); }

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
t('manifest.json is valid and has the required fields', man.name && man.start_url && man.display === 'standalone' && Array.isArray(man.icons) && man.icons.length > 0, JSON.stringify(man));
const demoManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-data', 'manifest.json'), 'utf8'));
t('demo-data has at least 10 sample folders', Array.isArray(demoManifest.folders) && demoManifest.folders.length >= 10, demoManifest.folders.length);

const hdr = {};
{ const lines = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split(/\r?\n/); let on = false;
  for (const l of lines) { if (/^\S/.test(l)) on = l.trim() === '/*'; else if (on && /^\s+[\w-]+:/.test(l)) { const i = l.indexOf(':'); hdr[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.pdf': 'application/pdf', '.md': 'text/markdown' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }, hdr));
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ORIGIN = 'http://127.0.0.1:' + server.address().port;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'search-e2e-demo-'));
  const port = 9900 + Math.floor(Math.random() * 300);
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-background-networking', '--disable-component-update', 'about:blank'], { stdio: 'ignore' });
  const getJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
  let ws = null;
  try {
    let tabs = null; for (let i = 0; i < 60 && !tabs; i++) { try { tabs = (await getJson('/json')).filter((x) => x.type === 'page'); } catch { await sleep(200); } }
    ws = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pend = {}, requests = [], errors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
      if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
      if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const until = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() > end) return v; await sleep(200); } };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    // No display-mode override here: a plain navigation is display-mode "browser" by default, exactly like a visitor's tab.
    await send('Page.navigate', { url: ORIGIN + '/' });

    const demoScreen = await until('!!document.getElementById("demoBtn")');
    t('a plain browser tab shows the demo screen, not the real picker', !!demoScreen && (await ev('!document.getElementById("pickBtn")')) === true, await ev('document.body.innerText.slice(0,200)'));

    const search = async (q, mark) => {
      await ev(`(function(){ var s = document.getElementById("search"); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      return until(`(function(){ var m = document.querySelector(".snippet mark"); return m && document.querySelector(".snippet").textContent.indexOf(${JSON.stringify(mark)}) >= 0; })()`, 20000);
    };

    await ev('document.getElementById("demoBtn").click()');
    const listed = await until('document.body.innerText.includes("pasta-notes.txt")', 20000);
    t('the demo folders are listed after clicking Try the demo', !!listed, await ev('document.body.innerText.slice(0,300)'));

    t('a word inside a demo .txt is found', !!(await search('weeknight pasta', 'pasta')));
    t('a word inside a demo .html is found', !!(await search('fremen', 'Fremen')));
    t('a word inside a demo .pdf is found (pdf.js extracts the text)', !!(await search('marigold', 'Marigolds')));

    const dup = await until('document.body.innerText.indexOf("duplicate group") >= 0', 20000);
    t('the two identical "weekly-status.txt" files are found as duplicates', !!dup, await ev('(document.getElementById("indexStatus")||{}).textContent'));

    await sleep(500);
    const own = (u) => u.startsWith(ORIGIN + '/') || /^(blob|data|about|chrome-extension):/.test(u);
    const foreign = requests.filter((u) => !own(u));
    t('no request leaves the page origin', foreign.length === 0, foreign.join(' | '));

    const swReady = await until('(async function(){ try { var r = await navigator.serviceWorker.getRegistration(); return !!r; } catch(e){ return false; } })()', 10000);
    t('the service worker registers', !!swReady);
    t('no uncaught error while running the demo', errors.length === 0, errors.join(' | '));
  } catch (e) {
    t('unexpected error', false, e && e.stack);
  } finally {
    await closeEdge({ ws, child: edge, prof });
    server.close();
  }
  process.exit(fails ? 1 : 0);
})();
