/** p3-print-measure.mjs —— 用 CDP 打印媒体仿真，量出图表在打印态下的真实尺寸。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9457;
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const OUT = ROOT + '/.probe/p3-print-measure.json';
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
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params);
    });
  }
  on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}
async function waitHttp(url, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ } await sleep(200); }
  throw new Error('timeout ' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p3print-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  const report = { steps: [], checks: {} };
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8787','--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    const waitEval = async (expr, label, timeout = 30000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) { try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* */ } await sleep(250); }
      throw new Error('timeout ' + label);
    };
    const spaNav = async (route, pred, label) => {
      await cdp.eval('(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' + JSON.stringify(route) + ')');
      await waitEval(pred, label);
    };

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
    await sleep(2000);

    const measure = '(function(){ var out={ screenWidth: window.innerWidth, charts: [] }; var cs=document.querySelectorAll(".print-chart"); for (var i=0;i<cs.length;i++){ var c=cs[i]; var cv=c.querySelector("canvas"); var svg=c.querySelector("svg"); var r=c.getBoundingClientRect(); out.charts.push({ cls:c.className, w: Math.round(r.width), h: Math.round(r.height), canvasW: cv? cv.width: null, canvasH: cv? cv.height: null, canvasCssW: cv? cv.style.width: null, svgW: svg? svg.getAttribute("width"): null }); } var cards=document.querySelectorAll("[data-testid=\\"report-charts\\"] > *"); out.cardCount = cards.length; var pc=document.querySelector("[data-testid=\\"report-page\\"]"); if(pc){ var pr=pc.getBoundingClientRect(); out.pageW=Math.round(pr.width); } var rc=document.querySelector("[data-testid=\\"report-charts\\"]"); if(rc){ out.chartsSectionW=Math.round(rc.getBoundingClientRect().width); } out.dpr=window.devicePixelRatio; return out; })()';

    report.checks.screen = await cdp.eval(measure);

    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(1200);
    report.checks.printMedia = await cdp.eval(measure);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(ROOT + '/.probe/p3-print-media.png', Buffer.from(shot.data, 'base64'));
    // 真实 PDF 输出，量页面数
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(ROOT + '/.probe/p3-report.pdf', Buffer.from(pdf.data, 'base64'));
    report.checks.pdfBytes = Buffer.from(pdf.data, 'base64').length;
    report.checks.pdfBase64Len = pdf.data.length;
    report.ok = true;
  } catch (e) {
    report.ok = false; report.error = String(e && e.message ? e.message : e);
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });