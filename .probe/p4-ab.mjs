/**
 * p4-print-truth.mjs —— 「打印预览里图表是空白」的真实路径复现。
 *
 * 为什么需要它：p3-print-verify.mjs 在 printToPDF 之前先执行了
 * `Emulation.setEmulatedMedia({media:'print'})` 并 sleep(1500)，
 * 等于提前把页面切进打印态、还给了 1.5 秒让 zrender 重绘 —— 真实 Ctrl+P
 * 没有这一段，因此 p3 的 ok=true 很可能是假阳性。
 *
 * 本探针默认走 truth 模式：不设置 emulated media、不 sleep，直接 printToPDF，
 * 并用 Page.addScriptToEvaluateOnNewDocument 在页面里记录 beforeprint/afterprint
 * 时间线，以及 beforeprint 之后逐帧采样画布墨迹（判断「快照时画布是否还空着」）。
 *
 * 输出：.probe/p4-print-truth-<mode>.json 与 .probe/p4-print-<mode>.pdf
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
import { PYTHON as PY } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8795/';
const CDP_PORT = 9475;
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] || 'truth';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
  for (let i = 0; i < 60; i += 1) rows.push('转轴直径,' + (12 + Math.sin(i * 0.5) * 0.006).toFixed(4) + ',12.02,11.98');
  return rows.join('\n');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params);
    });
  }
  on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}

async function waitHttp(url, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ }
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

/** 注入到页面：记录打印事件时间线 + 逐帧采样画布墨迹。 */
const INSTRUMENT = String.raw`
window.__tl = [];
window.__samples = [];
window.__ink = function () {
  var out = [];
  var cvs = [].slice.call(document.querySelectorAll('.print-chart canvas'));
  for (var i = 0; i < cvs.length; i += 1) {
    var w = 140, h = 70;
    var o = document.createElement('canvas'); o.width = w; o.height = h;
    var ctx = o.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    try { ctx.drawImage(cvs[i], 0, 0, w, h); } catch (e) { out.push(-1); continue; }
    var d = ctx.getImageData(0, 0, w, h).data;
    var ink = 0;
    for (var k = 0; k < d.length; k += 4) { if (d[k] < 245 || d[k+1] < 245 || d[k+2] < 245) ink += 1; }
    out.push(Math.round(ink / (w * h) * 10000) / 10000);
  }
  return out;
};
window.__boxes = function () {
  return [].slice.call(document.querySelectorAll('.print-chart canvas')).map(function (cv) {
    var b = cv.getBoundingClientRect();
    return { cssW: Math.round(b.width), cssH: Math.round(b.height), px: cv.width + 'x' + cv.height };
  });
};
window.addEventListener('beforeprint', function () {
  window.__tl.push({ e: 'beforeprint', t: Math.round(performance.now()), ink: window.__ink(), boxes: window.__boxes() });
  var n = 0;
  (function tick() {
    window.__samples.push({ f: n, t: Math.round(performance.now()), ink: window.__ink(), nCanvas: document.querySelectorAll('.print-chart canvas').length });
    n += 1;
    if (n < 10) requestAnimationFrame(tick);
  })();
});
window.addEventListener('afterprint', function () {
  window.__tl.push({ e: 'afterprint', t: Math.round(performance.now()), ink: window.__ink() });
});
if (window.matchMedia) {
  try {
    window.matchMedia('print').addEventListener('change', function (e) {
      window.__tl.push({ e: 'mq-change(' + e.matches + ')', t: Math.round(performance.now()), ink: window.__ink() });
    });
  } catch (err) { /* */ }
}
`;

const PREP = "var brk = document.querySelector('.print-page-break'); var stack = document.querySelector('[data-testid=\"report-charts\"]');";
const SCEN = [
  {
    "id": "asis",
    "apply": "return true;",
    "revert": "return true;"
  },
  {
    "id": "nobreak",
    "apply": "if(brk) brk.classList.remove(\"print-page-break\"); return !!brk;",
    "revert": "if(brk) brk.classList.add(\"print-page-break\"); return !!brk;"
  },
  {
    "id": "nobreak-block",
    "apply": "if(brk){ brk.classList.remove(\"print-page-break\"); brk.style.display=\"block\"; } return !!brk;",
    "revert": "if(brk){ brk.classList.add(\"print-page-break\"); brk.style.display=\"\"; } return !!brk;"
  },
  {
    "id": "block-only",
    "apply": "if(stack) stack.style.display=\"block\"; return !!stack;",
    "revert": "if(stack) stack.style.display=\"\"; return !!stack;"
  },
  {
    "id": "nogap-block",
    "apply": "if(brk){ brk.classList.remove(\"print-page-break\"); brk.style.display=\"block\"; } if(stack){ var k=[].slice.call(stack.children); for(var i=1;i<k.length;i++) k[i].style.marginTop=\"16px\"; } return true;",
    "revert": "if(brk){ brk.classList.add(\"print-page-break\"); brk.style.display=\"\"; } if(stack){ var k=[].slice.call(stack.children); for(var i=0;i<k.length;i++) k[i].style.marginTop=\"\"; } return true;"
  }
];

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p4ab-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const report = { steps: [], results: [] };
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server', '--host', '127.0.0.1', '--port', '8795', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

    const waitEval = async (expr, label, timeout = 30000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* */ }
        await sleep(250);
      }
      throw new Error('timeout ' + label);
    };
    const clickText = (text) => cdp.eval('(function(){ var b = [].slice.call(document.querySelectorAll("button")).filter(function(e){ return e.textContent.trim() === ' + JSON.stringify(text) + '; })[0]; if (b) { b.click(); return true; } return false; })()');
    const spaNav = async (route, pred, label) => {
      await cdp.eval('(function(h){ var a = [].slice.call(document.querySelectorAll("a[href]")).filter(function(e){ return (e.getAttribute("href") || "") === h; })[0]; if (!a) return false; a.click(); return true; })(' + JSON.stringify(route) + ')');
      await waitEval(pred, label);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await spaNav('/import', '!!document.querySelector("[data-testid=\'import-page\']")', '导入页');
    await cdp.eval('(function(){ var t = [].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){ return e.textContent.indexOf("粘贴 CSV") >= 0; })[0]; if (t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\'paste-input\']")', '粘贴框');
    await cdp.eval('(function(){ var el = document.querySelector("textarea[data-testid=\'paste-input\']"); var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; s.call(el, ' + JSON.stringify(buildCsv()) + '); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await clickText('解析');
    await waitEval('(function(){ var b = [].slice.call(document.querySelectorAll("button")).filter(function(e){ return e.textContent.trim() === "确认导入并分析"; })[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await clickText('确认导入并分析');
    await waitEval('!!document.querySelector("[data-testid=\'capability-page\']")', '能力页');
    await spaNav('/report', '!!document.querySelector("[data-testid=\'report-charts\']")', '报表页');
    await sleep(2500);

    for (const sc of SCEN) {
      const applied = await cdp.eval('(function(){ ' + PREP + sc.apply + ' })()');
      await sleep(400);
      const res = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      const p = ROOT + '/.probe/p4-ab-' + sc.id + '.pdf';
      fs.writeFileSync(p, Buffer.from(res.data, 'base64'));
      const outdir = ROOT + '/.probe/p4-ab-' + sc.id;
      execFileSync(PY, [ROOT + '/.workbuddy/tmp/render.py', p, outdir, '120'], { encoding: 'utf8' });
      const files = fs.readdirSync(outdir).filter((f) => /^p\d+\.png$/.test(f)).sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4)));
      const ink = JSON.parse(execFileSync(PY, [ROOT + '/.workbuddy/tmp/ink.py'].concat(files.map((f) => path.join(outdir, f))), { encoding: 'utf8' }));
      report.results.push({ id: sc.id, applied: applied, pages: files.length, perPage: files.map((f) => Number((ink[path.join(outdir, f)] || {}).inkRatio ?? -1)) });
      await cdp.eval('(function(){ ' + PREP + sc.revert + ' })()');
      await sleep(300);
    }
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.message) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p4-ab.json', JSON.stringify(report, null, 2), 'utf8');
    for (const r of report.results) console.log(r.id.padEnd(15) + ' pages=' + r.pages + '  ink=' + JSON.stringify(r.perPage));
    if (report.error) console.log('ERROR', report.error);
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
