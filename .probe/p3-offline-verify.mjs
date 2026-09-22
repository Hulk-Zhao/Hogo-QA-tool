/** p3-offline-verify.mjs —— 离线单文件版（用户实际双击的那个 index.html）的打印 PDF + Excel 内嵌图验收。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
import { PYTHON as PY } from './_env.mjs';
const APP_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9469;
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const PDF = ROOT + '/.probe/p3-offline-print.pdf';
const XLSX = ROOT + '/.probe/downloads/offline-report.xlsx';
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
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; }
}
async function waitHttp(url, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ } await sleep(200); } throw new Error('timeout ' + url); }

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p3off-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile,'--window-size=1500,1000','about:blank'], { stdio: 'ignore' });
  const report = { steps: [], asserts: [], ok: false };
  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });
  try {
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const waitEval = async (expr, label, timeout = 30000) => { const dl = Date.now() + timeout; while (Date.now() < dl) { try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* */ } await sleep(250); } throw new Error('timeout ' + label); };
    const spaNav = async (hash, pred, label) => { await cdp.eval('(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' + JSON.stringify(hash) + ')'); await waitEval(pred, label); };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '离线单文件应用加载');
    await spaNav('#/import', '!!document.querySelector("[data-testid=\\"import-page\\"]")', '导入页');
    await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\\"paste-input\\"]")', '粘贴框');
    await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(buildCsv()) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return true; })()');
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
    await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"capability-page\\"]")', '能力页');
    await spaNav('#/report', '!!document.querySelector("[data-testid=\\"report-charts\\"]")', '报表页');
    await sleep(2500);

    // ---------- 1) 打印 PDF ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(1500);
    report.browser = await cdp.eval('(function(){ var out={ canvases: [] }; [].slice.call(document.querySelectorAll(".print-chart canvas")).forEach(function(cv){ var b=cv.getBoundingClientRect(); out.canvases.push({ cssW: Math.round(b.width), cssH: Math.round(b.height), attrW: cv.width, attrH: cv.height }); }); return out; })()');
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(PDF, Buffer.from(pdf.data, 'base64'));
    await cdp.send('Emulation.setEmulatedMedia', { media: '' });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(800);
    execFileSync(PY, [ROOT + '/.workbuddy/tmp/p3-pdf-report.py', PDF], { encoding: 'utf8' });
    report.pdf = JSON.parse(fs.readFileSync(ROOT + '/.probe/p3-pdf-report.json', 'utf8'));

    // ---------- 2) 导出 Excel ----------
    await cdp.eval(`(function(){ window.__blob=null; var o=URL.createObjectURL; URL.createObjectURL=function(b){ window.__blob=b; return o.call(URL,b); }; return true; })()`);
    await cdp.eval('(function(){ document.querySelector("[data-testid=\\"export-excel\\"]").click(); return true; })()');
    let cap = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      cap = await cdp.eval(`(async function(){ if(!window.__blob) return null; var buf=await window.__blob.arrayBuffer(); var b=new Uint8Array(buf); var c=8192,p=[]; for(var i=0;i<b.length;i+=c){p.push(String.fromCharCode.apply(null,b.subarray(i,i+c)));} return { size: b.length, b64: btoa(p.join('')) }; })()`);
      if (cap && cap.size > 0) break;
      await sleep(400);
    }
    if (!cap) throw new Error('离线版没有捕获到导出 Blob');
    fs.mkdirSync(path.dirname(XLSX), { recursive: true });
    fs.writeFileSync(XLSX, Buffer.from(cap.b64, 'base64'));
    report.toast = await cdp.eval('(function(){ return [].slice.call(document.querySelectorAll("[data-testid=\\"toast\\"]")).map(function(e){ return e.textContent; }); })()');
    execFileSync(PY, [ROOT + '/.workbuddy/tmp/p3-xlsx-report.py', XLSX], { encoding: 'utf8' });
    report.xlsx = JSON.parse(fs.readFileSync(ROOT + '/.probe/p3-xlsx-report.json', 'utf8'));

    const printableW = report.pdf.pageW - 2 * (12 / 25.4) * 72;
    const imgs = report.pdf.images;
    check('离线版：PDF 里 3 张图表位图', imgs.length === 3, 'n=' + imgs.length);
    check('离线版：图表铺满可打印宽（≥90%）且不越界', imgs.length > 0 && imgs.every((i) => !i.overflow && i.placedPtW / printableW >= 0.9), 'min=' + Math.min.apply(null, imgs.map((i) => (i.placedPtW / printableW).toFixed(3))));
    check('离线版：图表有效分辨率 ≥200 DPI', imgs.length > 0 && imgs.every((i) => i.effDpi >= 200), 'min=' + Math.min.apply(null, imgs.map((i) => i.effDpi)));
    check('离线版：无空白页', (() => { const withImgs = new Set(imgs.map((i) => i.page)); return report.pdf.pageTextExtents.every((p) => p.blocks > 0 || withImgs.has(p.page)); })(), JSON.stringify(report.pdf.pageTextExtents.map((p) => p.blocks)));
    check('离线版：Excel 5 个 sheet（含「图表」）', report.xlsx.sheetnames.length === 5 && report.xlsx.sheetnames[4] === '图表', JSON.stringify(report.xlsx.sheetnames));
    check('离线版：Excel 内嵌 PNG 且能被 PIL 打开', report.xlsx.media.length >= 2 && report.xlsx.media.every((m) => m.format === 'PNG'), JSON.stringify(report.xlsx.media.map((m) => m.size)));
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) { report.error = String((e && e.message) || e); }
  finally {
    try { chrome.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p3-offline-verify.json', JSON.stringify(report, null, 2), 'utf8');
    console.log('--- steps ---');
    console.log(JSON.stringify({ steps: report.steps, canvases: report.browser ? report.browser.canvases : null, toast: report.toast, error: report.error }, null, 2));
    console.log('--- pdf ---');
    console.log(JSON.stringify(report.pdf ? { pages: report.pdf.pages, images: report.pdf.images.map((i) => ({ px: i.px, mm: i.placedMm, dpi: i.effDpi, overflow: i.overflow })) } : null, null, 2));
    console.log('--- xlsx ---');
    console.log(JSON.stringify(report.xlsx ? { sheets: report.xlsx.sheetnames, media: report.xlsx.media.map((m) => ({ n: m.name, size: m.size, bytes: m.bytes })), imgs: report.xlsx.openpyxl_images } : null, null, 2));
    console.log('--- asserts ---');
    for (const a of report.asserts) console.log((a.pass ? 'PASS ' : 'FAIL ') + a.name + '  [' + a.detail + ']');
    console.log('ok =', report.ok);
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
