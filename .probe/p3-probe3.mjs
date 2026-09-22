/** p3-probe3.mjs —— 真正的打印排版探测：A4 视口 + print 媒体查询，逐级量图表祖先宽度。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8788/';
const CDP_PORT = 9461;
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
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
  const profile = path.join(os.tmpdir(), 'hogo-p3probe3-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const args = ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile, 'about:blank'];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  const report = { steps: [], checks: {} };
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8788','--strictPort'], { cwd: ROOT, stdio: 'ignore' });
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

    // 关键：把视口压成 A4 可打印内容区（A4 794px - 12mm*2 边距 = 703px 内容 + 边距）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(1500);

    report.checks.geometry = await cdp.eval(`(function(){
      var out = {};
      out.dpr = window.devicePixelRatio;
      out.innerW = window.innerWidth;
      out.docScrollW = document.documentElement.scrollWidth;
      out.bodyScrollW = document.body.scrollWidth;
      var cv = document.querySelector('.print-chart canvas');
      if (cv) {
        var chain = [];
        var el = cv;
        while (el && el !== document.documentElement) {
          var r = el.getBoundingClientRect();
          chain.push({ tag: el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : ''), w: Math.round(r.width), left: Math.round(r.left), cssW: Math.round(el.getBoundingClientRect().width), styleW: el.style && el.style.width, maxW: getComputedStyle(el).maxWidth, minW: getComputedStyle(el).minWidth, overflowX: getComputedStyle(el).overflowX });
          el = el.parentElement;
        }
        out.canvasChain = chain;
        var r = cv.getBoundingClientRect();
        out.canvas = { cssW: Math.round(r.width), cssH: Math.round(r.height), attrW: cv.width, attrH: cv.height, inline: cv.getAttribute('style') };
      }
      // 找出所有宽度超过 703 的元素（元凶候选）
      var wide = [];
      [].slice.call(document.querySelectorAll('*')).forEach(function(e){
        var r = e.getBoundingClientRect();
        if (r.width > 710) wide.push({ tag: e.tagName, cls: (typeof e.className === 'string' ? e.className : '').split(' ').slice(0,3).join(' '), w: Math.round(r.width), left: Math.round(r.left) });
      });
      out.wide = wide.slice(0, 25);
      out.wideCount = wide.length;
      return out;
    })()`);

    fs.writeFileSync(ROOT + '/.probe/p3-probe3.pdf.json', JSON.stringify(report, null, 2), 'utf8');
    report.ok = true;
  } catch (e) { report.ok = false; report.error = String(e && e.message ? e.message : e); }
  finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p3-probe3.json', JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
