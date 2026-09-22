/** p2-repro-spec.mjs —— 复现/验收：导入带规格限的数据后，能力页规格限是否被预填。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9453;
const OUT = 'E:/tools/Hogo-QA-tool/.probe/p2-spec-result.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) {
    rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
  }
  for (let i = 0; i < 60; i += 1) {
    rows.push('转轴直径,' + (12 + Math.sin(i * 0.5) * 0.006).toFixed(4) + ',12.02,11.98');
  }
  return rows.join('\n');
}
const CSV = buildCsv();

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const h of this.handlers.get(m.method)) h(m.params);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}
async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p2spec-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  const report = { steps: [], checks: {}, pageErrors: [], consoleErrors: [] };
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8787','--strictPort'], { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    await waitForHttp(APP_URL, 30000);
    await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => report.pageErrors.push((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || 'x'));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') report.consoleErrors.push(p.args.map((a) => a.value || a.description || '').join(' ')); });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false });

    const waitEval = async (expr, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };
    const spaNav = async (route, predicate, label) => {
      const clicked = await cdp.eval('(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' + JSON.stringify(route) + ')');
      if (!clicked) throw new Error('未找到导航: ' + route);
      await waitEval(predicate, label);
    };
    const inputValue = async (label) => cdp.eval('(function(l){ var el=[].slice.call(document.querySelectorAll("input")).filter(function(e){return e.getAttribute("aria-label")===l;})[0]; return el? el.value : null; })(' + JSON.stringify(label) + ')');

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await spaNav('/import', '!!document.querySelector("[data-testid=\\"import-page\\"]")', '导入页');
    await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\\"paste-input\\"]")', '粘贴框');
    await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(CSV) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return el.value.length; })()');
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
    await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"capability-page\\"]")', '能力页');
    await sleep(1500);

    report.checks.uslInput = await inputValue('USL');
    report.checks.lslInput = await inputValue('LSL');
    report.checks.cpkCell = await cdp.eval('(function(){ var e=document.querySelector("[data-testid=\\"capability-cpk\\"]"); return e? e.textContent : null; })()');
    report.checks.capabilityPageText = await cdp.eval('(function(){ var e=document.querySelector("[data-testid=\\"capability-page\\"]"); return e? e.innerText.slice(0,600) : null; })()');
    report.checks.characteristicOptions = await cdp.eval('(function(){ var s=document.querySelector("[data-testid=\\"characteristic-select\\"]"); return s? s.textContent : null; })()');

    // 报表页对照：报表用的是 characteristic.specLimits
    await spaNav('/report', '!!document.querySelector("[data-testid=\\"report-export-options\\"]")', '报表页');
    await sleep(1200);
    report.checks.reportCpkText = await cdp.eval('(function(){ var t=document.querySelectorAll("table"); for (var i=0;i<t.length;i++){ var x=t[i].innerText||""; if (x.indexOf("Cpk")>=0) return x.slice(0,300); } return null; })()');

    report.checks.pageErrors = report.pageErrors.length;
    report.checks.consoleErrors = report.consoleErrors.length;
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.message ? e.message : e);
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { if (preview) preview.kill(); } catch { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });