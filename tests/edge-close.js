'use strict';
// Closes a headless Edge started by a test or a tool, completely. A headless Edge detaches its processes from the one we
// spawn, so killing that process tree leaves the browser running (and every run adds another one in memory). Here:
// 1) ask the browser to close itself over the DevTools socket, 2) end every msedge.exe that uses this run's own
// --user-data-dir (never the user's own Edge), 3) delete that temporary profile.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// msedge.exe processes whose command line contains `needle` (a profile folder), as [pid].
function edgePids(needle) {
  if (process.platform !== 'win32') return [];
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:EDGE_NEEDLE) } | ForEach-Object { $_.ProcessId }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, EDGE_NEEDLE: needle }, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
}
function killPids(pids) {
  if (!pids.length) return;
  if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F'].concat(...pids.map((p) => ['/PID', String(p)])), { stdio: 'ignore', windowsHide: true });
  else pids.forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } });
}

// ws: the DevTools WebSocket (or null); child: the spawned process (or null); prof: the --user-data-dir of this run.
async function closeEdge({ ws, child, prof }) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch { /* closing anyway */ }
  await sleep(600);
  try { if (ws) ws.close(); } catch { /* closed */ }
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* gone */ } }
  if (prof) {
    for (let i = 0; i < 3; i++) { const left = edgePids(prof); if (!left.length) break; killPids(left); await sleep(400); }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(prof, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  }
}

// Ends every headless Edge left by an earlier run of the tests or tools (their profiles live in the temp folder and start
// with these prefixes). Returns how many processes were ended.
const PREFIXES = ['plc-online-', 'plc-cdp-', 'plc-e2e-', 'sim-shots-prof-', 'sim-shot-prof-', 'sim-col-prof-', 'live-es-', 'plc-shot-', 'plc-land-'];
function sweepEdge() {
  const tmp = os.tmpdir();
  const pids = new Set();
  PREFIXES.forEach((p) => edgePids(path.join(tmp, p)).forEach((x) => pids.add(x)));
  killPids([...pids]);
  return pids.size;
}

module.exports = { closeEdge, sweepEdge, edgePids };
if (require.main === module) console.log('ended ' + sweepEdge() + ' leftover headless Edge process(es)');
