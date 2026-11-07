'use strict';
// Search in a real Edge (headless) with a synthetic folder: a PDF, a .txt and an .html with markup and scripts.
// The folder lives in the browser's private storage (OPFS) and is handed to the app in place of the folder picker,
// so the whole flow runs as for a user: link, index, search (PDF, TXT, HTML), open a file, export, import a backup.
// Every network request of the page is recorded: the test fails if any leaves the page's own origin, or if a URL or a
// request body carries a file name, a path or the text of the synthetic files. The page gets the CSP of _headers.
// Run: node tests/e2e-edge.js   (skipped when Edge is not installed)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { closeEdge } = require('./edge-close.js');
const ROOT = path.join(__dirname, '..');
let fails = 0;
const t = (name, ok, extra) => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra || ''); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => fs.existsSync(p));
if (!EDGE) { console.log('PASS Edge is not installed: the browser test is skipped'); process.exit(0); }

// Synthetic content: unique markers that must never appear in any request.
const MARK = { pdf: 'PRESION SINTETICA 7731', txt: 'TXTSINTETICO4410', html: 'HTMLSINTETICO9921', dir: 'CarpetaSintetica', files: ['manual-bomba-sintetica.pdf', 'notas-sinteticas.txt', 'pagina-sintetica.html'] };
function pdfBytes(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- static server with the headers of _headers (/* block)
const hdr = {};
{ const lines = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split(/\r?\n/); let on = false;
  for (const l of lines) { if (/^\S/.test(l)) on = l.trim() === '/*'; else if (on && /^\s+[\w-]+:/.test(l)) { const i = l.indexOf(':'); hdr[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown' };
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'search-e2e-'));
  const port = 9600 + Math.floor(Math.random() * 300);
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
      if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, post: m.params.request.postData || '', type: m.params.type });
      if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map((a) => a.value || a.description).join(' '));
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const until = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() > end) return v; await sleep(200); } };
    await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
    await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    const pdf = Array.from(pdfBytes(MARK.pdf));
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
      window.__csp = []; document.addEventListener('securitypolicyviolation', function (e) { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); });
      window.__synth = (async function () {
        var root = await navigator.storage.getDirectory();
        try { await root.removeEntry(${JSON.stringify(MARK.dir)}, { recursive: true }); } catch (e) {}
        var dir = await root.getDirectoryHandle(${JSON.stringify(MARK.dir)}, { create: true });
        async function put(name, data) { var fh = await dir.getFileHandle(name, { create: true }); var w = await fh.createWritable(); await w.write(data); await w.close(); }
        await put(${JSON.stringify(MARK.files[0])}, new Uint8Array(${JSON.stringify(pdf)}));
        await put(${JSON.stringify(MARK.files[1])}, ${JSON.stringify(MARK.txt + ' <script>window.__xss1=1</script> <img src=x onerror="window.__xss2=1">')});
        await put(${JSON.stringify(MARK.files[2])}, ${JSON.stringify('<html><body><script>window.__xss3=1</script><img src="https://evil.invalid/pixel.png">' + MARK.html + '</body></html>')});
        return dir;
      })();
      window.showDirectoryPicker = function () { return window.__synth; };
      window.confirm = function () { return true; };
      window.__opened = []; window.open = function (u) { window.__opened.push(String(u)); return null; };
      window.__blobTypes = []; var cou = URL.createObjectURL; URL.createObjectURL = function (b) { window.__blobTypes.push(b && b.type); return cou.call(URL, b); };
    })();` });
    await send('Page.navigate', { url: ORIGIN + '/' });
    await until('!!document.getElementById("ackBtn")');
    await ev('document.getElementById("ackBtn").click()');   // the privacy note of the first visit
    await until('!!document.getElementById("pickBtn")');
    await ev('document.getElementById("pickBtn").click()');
    // indexing done: the three files are listed
    const listed = await until(`document.body.innerText.includes(${JSON.stringify(MARK.files[0])}) && document.body.innerText.includes(${JSON.stringify(MARK.files[2])})`, 20000);
    t('the synthetic folder is linked and its files are listed', !!listed, await ev('JSON.stringify({status: (document.getElementById("status")||{}).textContent, toast: (document.getElementById("toast")||{}).textContent, body: document.body.innerText.slice(0,300), synth: typeof window.__synth})') + ' ' + errors.join(' | '));
    const search = async (q, mark) => {
      await ev(`(function(){ var s = document.getElementById("search"); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      return until(`(function(){ var m = document.querySelector(".snippet mark"); return m && document.querySelector(".snippet").textContent.indexOf(${JSON.stringify(mark)}) >= 0; })()`, 20000);
    };
    t('a word inside the PDF is found (pdf.js 6 extracts the text)', !!(await search('sintetica 7731', '7731')));
    t('a word inside the .txt is found', !!(await search(MARK.txt.toLowerCase(), MARK.txt)));
    t('a word inside the .html is found', !!(await search(MARK.html.toLowerCase(), MARK.html)));
    t('scripts and tags of the documents never run or render: shown as text in the snippet', (await ev('!window.__xss1 && !window.__xss2 && !window.__xss3 && !document.querySelector(".snippet img, .snippet script") && !document.querySelector("img[src*=evil]")')) === true);
    // open the HTML file: a blob of type text/plain (source text), never a page of this origin
    await search(MARK.html.toLowerCase(), MARK.html);
    await ev('(function(){ var b = document.querySelector("button[data-act=view]"); if (b) b.click(); })()');
    const opened = await until('window.__opened.length ? window.__opened[0] : ""', 5000);
    const openedType = await ev('window.__blobTypes[window.__blobTypes.length - 1]');
    t('opening an .html file shows a blob of type text/plain', /^blob:/.test(String(opened)) && /^text\/plain/.test(String(openedType)), opened + ' ' + openedType);
    // export the results (Markdown download) and a backup, then import a backup
    await ev('document.getElementById("exportBtn").click()');
    await sleep(500);
    const backupFile = path.join(prof, 'backup-sintetico.json');
    const folderId = await ev('(async function(){ return null; })()');
    fs.writeFileSync(backupFile, JSON.stringify({ version: 1, folders: { old: MARK.dir }, favorites: { ['old::' + MARK.files[1]]: Date.now() }, collections: [{ id: 'c1', folderId: 'old', name: 'Coleccion sintetica', paths: [MARK.files[0]] }] }));
    const doc = await send('DOM.getDocument', { depth: -1 });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#backupFileInput' });
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [backupFile] });
    const imported = await until('document.body.innerText.indexOf("Coleccion sintetica") >= 0', 10000);
    t('a backup with a collection is imported', !!imported, folderId);
    await sleep(800);
    // ---- network
    const own = (u) => u.startsWith(ORIGIN + '/') || /^(blob|data|about|chrome-extension):/.test(u);
    const foreign = requests.filter((r) => !own(r.url));
    t('no request leaves the page origin', foreign.length === 0, foreign.map((r) => r.url).join(' | '));
    const secrets = [MARK.pdf, '7731', MARK.txt, MARK.html, MARK.dir].concat(MARK.files).map((s) => s.toLowerCase());
    const leaks = requests.filter((r) => secrets.some((s) => (decodeURIComponent(r.url) + ' ' + r.post).toLowerCase().includes(s)));
    t('no URL or request body carries a file name, the folder name or the text of a file', leaks.length === 0, leaks.map((r) => r.url).join(' | '));
    const fetched = [...new Set(requests.filter((r) => r.url.startsWith(ORIGIN)).map((r) => r.url.slice(ORIGIN.length)))];
    t('only the app files are requested (pdf.js and its worker included)', fetched.every((u) => /^\/(index\.html)?$|^\/(app\.js|favicon\.ico|js\/[\w-]+\.js|img\/[\w.-]+|vendor\/pdfjs\/pdf(\.worker)?\.min\.mjs)$/.test(u)) && fetched.includes('/vendor/pdfjs/pdf.worker.min.mjs'), fetched.join(' '));
    const csp = await ev('JSON.stringify(window.__csp)');
    t('no Content Security Policy or Trusted Types violation', csp === '[]' && !errors.some((e) => /TrustedScript|Content Security Policy|Refused/i.test(e)), csp + ' ' + errors.join(' | '));
    console.log('info: requests seen: ' + requests.length + ' (all same-origin app files), ' + fetched.join(' '));
    // ---- the page opened from disk (file://): browsers refuse ES modules there, so pdf.js loads as classic scripts
    await send('Page.navigate', { url: 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') });
    await until('!!(window.trustedTypes && trustedTypes.defaultPolicy)');   // app.js has started
    const disk = await ev(`(async function () {
      var mod = await import("./vendor/pdfjs/pdf.min.mjs").then(function () { return "loaded"; }, function () { return "refused"; });
      for (var src of ["vendor/pdfjs/pdf.worker.classic.js", "vendor/pdfjs/pdf.classic.js"]) {
        await new Promise(function (ok, bad) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
      }
      var lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";
      var doc = await lib.getDocument({ data: new Uint8Array(${JSON.stringify(pdf)}), isEvalSupported: false }).promise;
      var tc = await (await doc.getPage(1)).getTextContent();
      return { module: mod, version: lib.version, text: tc.items.map(function (i) { return i.str; }).join(" ") };
    })()`);
    t('from disk the ES module is refused (why the classic copies exist)', disk && disk.module === 'refused', JSON.stringify(disk));
    t('from disk the classic pdf.js copies read the text of a PDF', disk && disk.version === '6.4.299' && disk.text.indexOf(MARK.pdf) >= 0, JSON.stringify(disk));
  } catch (e) {
    t('unexpected error', false, e && e.stack);
  } finally {
    await closeEdge({ ws, child: edge, prof });
    server.close();
  }
  process.exit(fails ? 1 : 0);
})();
