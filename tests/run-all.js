'use strict';
// Runs every test of Search: node tests/run-all.js   (exit code 1 if any check fails)
const { spawnSync } = require('child_process');
const path = require('path');
let bad = 0;
for (const f of ['unit.js', 'e2e-edge.js']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = (out.match(/^PASS /gm) || []).length, fail = (out.match(/^FAIL /gm) || []).length;
  console.log(`${f.padEnd(14)} ${String(pass).padStart(3)} passed  ${fail} failed${r.status === 0 ? '' : '  (exit ' + r.status + ')'}`);
  out.split(/\r?\n/).filter((l) => /^FAIL /.test(l)).forEach((l) => console.log('   ' + l));
  if (r.status !== 0 || fail) bad++;
}
process.exit(bad ? 1 : 0);
