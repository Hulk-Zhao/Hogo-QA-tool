/**
 * p6-print-pages.mjs —— P6-B 真机真值：打印分页的「页数 + 每页留白」。
 *
 * 为什么要有这一层：P4 的护栏只看「有没有全空白页」，说明不了另外两件事：
 *   1) 中间某页被一整块不可拆分的内容挤空（实测第 3 页只用到 68.7%，尾部空 242pt）；
 *   2) 页数到底几页 —— 旧探针把渲染目录里的**陈旧 PNG** 也数进去（p4-render-truth/p5.png
 *      是 2026-09-19 的产物），于是 4 页被报成 5 页，看起来像「页数在 4~5 之间浮动」。
 * 本探针每次先清空渲染目录，再按「文字 bbox + 图片 bbox」量每页真正用到哪一行。
 *
 * 用法：
   node .probe/p6-print-pages.mjs            → 打 dist-server（开发服务器产物）
   node .probe/p6-print-pages.mjs offline    → 打 dist（用户双击的离线单文件）
 * 为什么要打 offline：用户实际双击的是 `dist/index.html`，打印样式在两套产物里
   必须同样生效；offline 用 `vite preview --outDir dist` 起本地 http 服务模拟同级环境。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
import { PYTHON as PY } from './_env.mjs';
/** offline 模式：打 dist 单文件产物（端口与 server 模式错开）。 */
const OFFLINE = (process.argv[2] || '') === 'offline';
const OUT_DIR = OFFLINE ? 'dist' : 'dist-server';
const APP_PORT = OFFLINE ? 8805 : 8803;
const CDP_PORT = OFFLINE ? 9485 : 9483;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const PDF = ROOT + '/.probe/p6-print-' + (OFFLINE ? 'offline' : 'server') + '.pdf';
const RENDER = ROOT + '/.probe/p6-render' + (OFFLINE ? '-offline' : '');
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
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}

async function waitHttp(url, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* */ }
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

/** 注入：记录打印事件时间线 + 逐帧采样画布（判断快照是否同步就位）。 */
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
window.addEventListener('beforeprint', function () { window.__tl.push({ e: 'beforeprint', t: Math.round(performance.now()), ink: window.__ink() }); });
window.addEventListener('afterprint', function () { window.__tl.push({ e: 'afterprint', t: Math.round(performance.now()), ink: window.__ink() }); });
if (window.matchMedia) {
  try {
    window.matchMedia('print').addEventListener('change', function (e) {
      window.__tl.push({ e: 'mq-change(' + e.matches + ')', t: Math.round(performance.now()), ink: window.__ink() });
    });
  } catch (err) { /* */ }
}
`;

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p6print-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const mode = OFFLINE ? 'p6-print-pages-offline' : 'p6-print-pages';
  const report = { mode, steps: [], pages: null, pdfImages: null, asserts: [], ok: null };
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', OUT_DIR, '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
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

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval('(function(h){ var a = [].slice.call(document.querySelectorAll("a[href]")).filter(function(e){ return (e.getAttribute("href") || "") === h; })[0]; a.click(); return true; })("/import")');
    await waitEval('!!document.querySelector(\'[data-testid="import-page"]\')', '导入页');
    await cdp.eval('(function(){ var t = [].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){ return e.textContent.indexOf("粘贴 CSV") >= 0; })[0]; if (t) t.click(); return true; })()');
    await waitEval('!!document.querySelector(\'textarea[data-testid="paste-input"]\')', '粘贴框');
    await cdp.eval('(function(){ var el = document.querySelector(\'textarea[data-testid="paste-input"]\'); var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; s.call(el, ' + JSON.stringify(buildCsv()) + '); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await clickText('解析');
    await waitEval('(function(){ var b = [].slice.call(document.querySelectorAll("button")).filter(function(e){ return e.textContent.trim() === "确认导入并分析"; })[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await clickText('确认导入并分析');
    await waitEval('!!document.querySelector(\'[data-testid="capability-page"]\')', '能力页');
    await cdp.eval('(function(h){ var a = [].slice.call(document.querySelectorAll("a[href]")).filter(function(e){ return (e.getAttribute("href") || "") === h; })[0]; a.click(); return true; })("/report")');
    await waitEval('!!document.querySelector(\'[data-testid="report-charts"]\')', '报表页');
    await sleep(2500);

    // 真实打印路径：不设置 emulated media、不额外 sleep
    const pdfRes = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(PDF, Buffer.from(pdfRes.data, 'base64'));
    const tl = await cdp.eval('window.__tl');

    const geom = JSON.parse(execFileSync(PY, [ROOT + '/.workbuddy/tmp/p6-pagegeom.py', PDF, RENDER, '120'], { encoding: 'utf8' }));
    report.pages = geom.pages;
    execFileSync(PY, [ROOT + '/.workbuddy/tmp/p3-pdf-report.py', PDF], { encoding: 'utf8' });
    report.pdfImages = JSON.parse(fs.readFileSync(ROOT + '/.probe/p3-pdf-report.json', 'utf8'));

    const pages = geom.pages;
    const n = pages.length;
    const nonLast = pages.slice(0, n - 1);
    const last = pages[n - 1];
    const imgs = report.pdfImages.images;
    const printableW = report.pdfImages.pageW - 2 * (12 / 25.4) * 72;
    const duringPrint = (tl.find((x) => x.e === 'mq-change(true)') || {}).ink || [];
    const check = (name, pass, detail) => { report.asserts.push({ name, pass: !!pass, detail }); };

    check('真实路径确实派发了 beforeprint', tl.some((x) => x.e === 'beforeprint'), tl.map((x) => x.e).join(' > '));
    check('打印快照同步就位（打印期画布数 >= 3）', duringPrint.length >= 3, 'during=' + duringPrint.length);
    check('PDF 内嵌 3 张位图（控制图 X / 控制图 R / 能力图）', imgs.length === 3, 'n=' + imgs.length);
    check('每张位图有效分辨率 >= 250 DPI', imgs.length === 3 && imgs.every((i) => i.effDpi >= 250), 'min=' + Math.min(...imgs.map((i) => i.effDpi)) + ' DPI');
    check('图表铺满可打印区 >= 80%', imgs.length === 3 && imgs.every((i) => i.placedPtW / printableW >= 0.8), 'min=' + (Math.min(...imgs.map((i) => i.placedPtW / printableW)) * 100).toFixed(1) + '%');
    check('没有全空白页（每页墨迹 > 0.002）', pages.every((p) => p.inkRatio > 0.002), 'min=' + Math.min(...pages.map((p) => p.inkRatio)));
    check('页数 <= 4（不许因为分页改动变多）', n <= 4, 'pages=' + n);
    check('非末页不留半页空白（每页至少用掉 80% 可打印高度）', nonLast.every((p) => p.usedRatio >= 0.8), nonLast.map((p) => 'p' + p.page + '=' + (p.usedRatio * 100).toFixed(1) + '%').join(' '));
    check('末页不是空尾页（墨迹 > 0.005）', last.inkRatio > 0.005, 'lastInk=' + last.inkRatio);
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.message) || e);
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p6-print-pages' + (OFFLINE ? '-offline' : '') + '.json', JSON.stringify(report, null, 1), 'utf8');
    console.log(JSON.stringify({ ok: report.ok, error: report.error || null, asserts: report.asserts.map((a) => (a.pass ? 'PASS ' : 'FAIL ') + a.name + ' :: ' + String(a.detail)) }, null, 1));
  }
}
await main();