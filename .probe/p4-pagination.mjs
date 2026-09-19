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

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const PY = 'C:/Users/22953/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const APP_URL = 'http://127.0.0.1:8793/';
const CDP_PORT = 9473;
const ROOT = 'E:/tools/Hogo-QA-tool';
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


/** 打印版面几何测量（只在诊断用，不参与验收）。 */
function measure() {
  var mm = 96 / 25.4;
  function info(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    return {
      tag: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
      testid: el.getAttribute('data-testid') || '',
      top: Math.round(r.top),
      h: Math.round(r.height),
      breakInside: cs.breakInside,
      breakBefore: cs.breakBefore,
      hasSnapshot: el.classList.contains('has-print-snapshot'),
      canvases: [].slice.call(el.querySelectorAll('canvas')).map(function (c) { return c.width + 'x' + c.height; }),
    };
  }
  var stack = document.querySelector('[data-testid="report-charts"]');
  var main = document.querySelector('.print-main') || document.body;
  return {
    pageW: Math.round(186 * mm),
    pageH: Math.round(273 * mm),
    viewport: window.innerWidth + 'x' + window.innerHeight,
    docScrollH: document.documentElement.scrollHeight,
    mainScrollH: main.scrollHeight,
    stack: stack ? info(stack) : null,
    stackDisplay: stack ? getComputedStyle(stack).display : '',
    mediaPrint: matchMedia('print').matches,
    stackChildren: stack ? [].slice.call(stack.children).map(info) : [],
    charts: [].slice.call(document.querySelectorAll('.print-chart')).map(info),
    mainChildren: [].slice.call(main.children).map(info),
  };
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p4page-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const report = { mode, steps: [] };
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server', '--host', '127.0.0.1', '--port', '8793', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
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

    // 把布局视口对齐到打印页面盒（186mm x 273mm @96dpi）——这是 printToPDF 的真实排版宽度。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 703, height: 1031, deviceScaleFactor: 1, mobile: false });

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

    report.screen = await cdp.eval('(' + String(measure) + ')()');
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(1500);
    report.print = await cdp.eval('(' + String(measure) + ')()');
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.message) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p4-pagination.json', JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
