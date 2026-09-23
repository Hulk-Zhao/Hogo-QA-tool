/**
 * p13-file-idb —— 定论：`file://` 下 Chrome 到底能不能用 IndexedDB？
 *
 * 为什么单独测这一条：README 与源码注释都写着「`file://` 下浏览器禁用 IndexedDB」，
 * 而 p10 探针输出的 `degraded:false` 一度被当成反证 —— 但 `degraded` 只代表
 * 「没有掉到内存兜底」，用 localStorage 兜底时它同样是 false，两种含义会混淆。
 * 所以这里绕开应用的所有封装，直接对浏览器问一次：`indexedDB.open()` 会不会成功。
 *
 * 用法：node .probe/p13-file-idb.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { CHROME } from './_env.mjs';

const ROOT = process.env.HOGO_ROOT || 'E:/tools/Hogo-QA-tool';
const APP_URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/dist/index.html';
const CDP_PORT = 9234;
const PROFILE = ROOT + '/.probe/p13-idb-profile';
const OUT = ROOT + '/.probe/p13-file-idb.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const id = ++seq; pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => ws.close(),
    }), ws.onerror = (e) => reject(new Error('WS error: ' + (e?.message ?? 'unknown')));
  });
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('PAGE EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,800', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let cdp;
const result = { ok: false };
try {
  if (!fs.existsSync(ROOT + '/dist/index.html')) throw new Error('缺 dist/index.html，先 npm run build');
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error('no CDP target');
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  result.location = await evaluate(cdp, `location.href`);
  result.probe = await evaluate(cdp, `(async () => {
    const out = { hasIndexedDB: typeof indexedDB !== 'undefined', openResult: 'pending' };
    try {
      out.openResult = await new Promise((res) => {
        const timer = setTimeout(() => res('timeout'), 2000);
        let req;
        try { req = indexedDB.open('__hogo_probe__', 1); } catch (e) { clearTimeout(timer); return res('throw:' + e.name); }
        req.onsuccess = () => { clearTimeout(timer); out.version = req.result.version; req.result.close(); res('onsuccess'); };
        req.onerror = () => { clearTimeout(timer); res('onerror'); };
        req.onblocked = () => { clearTimeout(timer); res('onblocked'); };
      });
    } catch (e) { out.openResult = 'outer-throw:' + e.name; }
    return out;
  })()`);
  // 直接问应用：项目库现在用的是哪个后端
  result.library = await evaluate(cdp, `(async () => {
    const mod = { };
    return {
      degradedHint: !!document.querySelector('[data-testid="library-degraded"]'),
      navEntries: (performance.getEntriesByType('navigation') || []).length,
    };
  })()`);
  cdp.close();
  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
} catch (e) {
  console.error('PROBE FAILED: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
}