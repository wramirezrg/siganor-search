'use strict';
// Unit checks of the pure modules: escaping of document text and file names, and validation of an imported backup.
// Run: node tests/unit.js   (or node tests/run-all.js)
const path = require('path');
const text = require(path.join(__dirname, '..', 'js', 'text.js'));
const backup = require(path.join(__dirname, '..', 'js', 'backup.js'));
let fails = 0;
const t = (name, ok, extra) => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra || ''); if (!ok) fails++; };

// ---- escaping
t('escapeHtml escapes & < > " \'', text.escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
const doc = 'Manual de bomba <script>alert(1)</script> y <img src=x onerror=alert(2)> "presion" de linea';
const snip = text.findSnippet(doc, ['presion'], text.fold(doc));
t('a snippet of a document with markup has no live tags, only <mark>', !!snip && !/<script|<img/i.test(snip) && /&lt;script&gt;/.test(snip) && /<mark>presion<\/mark>/.test(snip), snip);
const snip2 = text.findSnippet(doc, ['script'], text.fold(doc));
t('a search term inside a tag is marked as text, still escaped', /&lt;<mark>script<\/mark>&gt;/.test(snip2), snip2);

// ---- backup import (untrusted file)
const linked = [{ id: 'A', name: 'Docs' }];
let n = 0; const newId = () => 'new-' + (++n);
const base = (extra) => Object.assign({ favorites: {}, collections: [], folders: { old: 'Docs' } }, extra);
t('rejects a file that is not a backup', backup.remapBackup([], linked, new Set(), newId).ok === false && backup.remapBackup({ favorites: [], collections: [] }, linked, new Set(), newId).ok === false);
const r1 = backup.remapBackup(base({ favorites: { 'old::a.pdf': 1, 'old::': 2, 'nope::b.pdf': 3, 'old::c.pdf': 'x' } }), linked, new Set(), newId);
t('favorites: only valid keys of a linked folder with a numeric time are kept', r1.ok && Object.keys(r1.favorites).join() === 'A::a.pdf' && r1.skipped === 3, JSON.stringify(r1));
const longPath = 'x'.repeat(backup.BACKUP_MAX_PATH_LEN + 1);
const r2 = backup.remapBackup(base({ favorites: { ['old::' + longPath]: 1 }, collections: [
  { folderId: 'old', name: '  Bombas  ', id: 'k'.repeat(backup.BACKUP_MAX_ID_LEN + 1), paths: ['a.pdf', 7, '', longPath, null] },
  { folderId: 'old', name: 'Huge', paths: new Array(backup.BACKUP_MAX_PATHS + 1).fill('a.pdf') },
  { folderId: 'old', name: '', paths: [] },
] }), linked, new Set(), newId);
t('a path longer than the limit is dropped', r2.ok && Object.keys(r2.favorites).length === 0);
t('a collection keeps only valid paths, a trimmed name, and gets a new id when its id is too long', r2.collections.length === 1 && r2.collections[0].name === 'Bombas' && r2.collections[0].paths.join() === 'a.pdf' && /^new-/.test(r2.collections[0].id), JSON.stringify(r2.collections));
t('a collection with more paths than the limit is skipped, and so is one without a name', r2.skipped >= 3, String(r2.skipped));
const evil = JSON.parse('{"favorites":{"__proto__":{"polluted":1},"constructor::x":5},"collections":[{"folderId":"__proto__","name":"x","paths":["a"]}],"folders":{"__proto__":"Docs"}}');
const r3 = backup.remapBackup(evil, linked, new Set(), newId);
t('__proto__ and constructor keys never pollute objects (a folder id named __proto__ is just a name)', r3.ok && ({}).polluted === undefined && Object.getPrototypeOf(r3.favorites) === Object.prototype && !Object.prototype.hasOwnProperty.call(r3.favorites, '__proto__') && r3.collections.every((c) => c.folderId === 'A'), JSON.stringify(r3));
const many = {}; for (let i = 0; i <= 50000; i++) many['old::f' + i] = 1;
t('a backup with too many favorites is refused', backup.remapBackup(base({ favorites: many }), linked, new Set(), newId).ok === false);
process.exitCode = fails ? 1 : 0;

// ---- vendor/pdfjs: the files are the ones recorded in VERSION, and the classic copies come from the .mjs unchanged
{
  const fs = require('fs'), crypto = require('crypto');
  const dir = path.join(__dirname, '..', 'vendor', 'pdfjs');
  const ver = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8');
  const rows = [...ver.matchAll(/^sha256 (\S+) ([0-9a-f]{64})$/gm)];
  const bad = rows.filter(([, f, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex') !== h).map((r) => r[1]);
  t('vendor/pdfjs: every file matches the SHA-256 in VERSION', rows.length === 4 && bad.length === 0, bad.join(' '));
  const { toClassic } = require(path.join(__dirname, '..', 'tools', 'vendor-pdfjs.js'));
  const same = toClassic(fs.readFileSync(path.join(dir, 'pdf.min.mjs'), 'utf8'), 'pdfjsLib') === fs.readFileSync(path.join(dir, 'pdf.classic.js'), 'utf8')
    && toClassic(fs.readFileSync(path.join(dir, 'pdf.worker.min.mjs'), 'utf8'), null) === fs.readFileSync(path.join(dir, 'pdf.worker.classic.js'), 'utf8');
  t('vendor/pdfjs: the classic copies are exactly the conversion of the .mjs files', same);
  const v = (ver.match(/pdfjs-dist\) (\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  t('vendor/pdfjs: pdf.js is at least 6.2.108 (GHSA-wgrm-67xf-hhpq and GHSA-hq66-cqwq-w95j fixed)', v.length === 3 && (v[0] > 6 || (v[0] === 6 && (v[1] > 2 || (v[1] === 2 && v[2] >= 108)))), v.join('.'));
}
process.exitCode = fails ? 1 : 0;
