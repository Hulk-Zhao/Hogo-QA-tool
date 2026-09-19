/** p3-print-verify.mjs —— 打印/PDF 图表的可证伪验收：A4 视口 + print 媒体 + printToPDF + PDF 内图片实测。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const PY = 'C:/Users/22953/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const APP_URL = 'http://127.0.0.1:8789/';
const CDP_PORT = 9463;
const ROOT = 'E:/tools/Hogo-QA-tool';
const PDF = ROOT + '/.probe/p3-print.pdf';
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
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
      else if (m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params);
    });
  }
  on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}
async function waitHttp(url, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ } await sleep(200); } throw new Error('timeout ' + url); }

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p3pv-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const report = { steps: [], browser: {}, pdf: null, asserts: [], ok: false };
  let preview;
  const check = (name, pass, detail) => { report.asserts.push({ name, pass: !!pass, detail }); };
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8789','--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const waitEval = async (expr, label, timeout = 30000) => { const dl = Date.now() + timeout; while (Date.now() < dl) { try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* */ } await sleep(250); } throw new Error('timeout ' + label); };
    const spaNav = async (route, pred, label) => { await cdp.eval('(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' + JSON.stringify(route) + ')'); await waitEval(pred, label); };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await spaNav('/import', '!!document.querySelector("[data-testid=\\"import-page\\"]")', '导入页');
    await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\\"paste-input\\"]")', '粘贴框');
    await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(buildCsv()) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return true; })()');
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
    await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"capability-page\\"]")', '能力页');
    await spaNav('/report', '!!document.querySelector("[data-testid=\\"report-charts\\"]")', '报表页');
    await sleep(2500);

    // A4 视口（794px = 210mm @96dpi），等价于真实 Chrome 打印时的重排宽度
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(1500);

    report.browser = await cdp.eval(`(function(){
      var out = { dpr: window.devicePixelRatio, innerW: window.innerWidth, docScrollW: document.documentElement.scrollWidth, canvases: [] };
      var node = document.querySelector('[data-testid="report-charts"]');
      if (node) {
        var r = node.getBoundingClientRect();
        out.chartsBox = { w: Math.round(r.width), left: Math.round(r.left) };
      }
      [].slice.call(document.querySelectorAll('.print-chart canvas')).forEach(function(cv){
        var b = cv.getBoundingClientRect();
        out.canvases.push({ cssW: Math.round(b.width), cssH: Math.round(b.height), attrW: cv.width, attrH: cv.height, ratio: cv.width / Math.max(1, Math.round(b.width)) });
      });
      return out;
    })()`);

    const pdfRes = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(PDF, Buffer.from(pdfRes.data, 'base64'));

    const pyOut = execFileSync(PY, [ROOT + '/.workbuddy/tmp/p3-pdf-report.py', PDF], { encoding: 'utf8' });
    report.pdf = JSON.parse(pyOut);

    const pageW = report.pdf.pageW;
    const printableW = pageW - 2 * (12 / 25.4) * 72; // 12mm 边距
    const imgs = report.pdf.images;
    check('PDF 里图表位图数量 == 3（控制图主/副 + 直方图）', imgs.length === 3, 'n=' + imgs.length);
    check('没有图片超出纸张右边缘', imgs.every((i) => !i.overflow), imgs.map((i) => i.overflow).join(','));
    check('图表宽度覆盖可打印区 >= 90%', imgs.length > 0 && imgs.every((i) => i.placedPtW / printableW >= 0.9), 'min=' + Math.min.apply(null, imgs.map((i) => (i.placedPtW / printableW).toFixed(3))) + ' printable=' + printableW.toFixed(1) + 'pt');
    check('图表有效分辨率 >= 200 DPI', imgs.length > 0 && imgs.every((i) => i.effDpi >= 200), 'min=' + Math.min.apply(null, imgs.map((i) => i.effDpi)));
    check('页面宽度=A4', Math.abs(pageW - 595) < 2, String(pageW));
    const withImgs = new Set(imgs.map((i) => i.page));
    const blank = report.pdf.pageTextExtents
      .filter((p) => p.blocks === 0 && !withImgs.has(p.page))
      .map((p) => p.page);
    check('没有空白页（每页至少 1 个文字块或图片）', blank.length === 0, 'blank=' + JSON.stringify(blank) + ' pages=' + report.pdf.pages);
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) { report.error = String((e && e.message) || e); }
  finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p3-print-verify.json', JSON.stringify(report, null, 2), 'utf8');
    console.log('--- browser ---');
    console.log(JSON.stringify(report.browser, null, 2));
    console.log('--- pdf images ---');
    console.log(JSON.stringify(report.pdf ? report.pdf.images : null, null, 2));
    console.log('--- asserts ---');
    for (const a of report.asserts) console.log((a.pass ? 'PASS ' : 'FAIL ') + a.name + '  [' + a.detail + ']');
    console.log('ok =', report.ok, report.error ? 'ERROR: ' + report.error : '');
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
