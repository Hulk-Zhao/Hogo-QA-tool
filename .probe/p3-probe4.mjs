/** p3-probe4.mjs —— 判定：printToPDF 时 Chrome 是否把布局重排到纸张宽度、且是否触发 window resize / matchMedia('print')。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8790/';
const CDP_PORT = 9465;
const ROOT = 'E:/tools/Hogo-QA-tool';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function buildCsv() { const rows = ['物料名称,测量值,USL,LSL']; for (let i = 0; i < 60; i += 1) rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8'); for (let i = 0; i < 60; i += 1) rows.push('转轴直径,' + (12 + Math.sin(i * 0.5) * 0.006).toFixed(4) + ',12.02,11.98'); return rows.join('\n'); }
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); ws.addEventListener('message', (ev) => { const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } else if (m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params); }); } on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); } send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); } async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; } }
async function waitHttp(url, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ } await sleep(200); } throw new Error('timeout ' + url); }
async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p3probe4-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile, '--window-size=1578,1000', 'about:blank'], { stdio: 'ignore' });
  const out = { steps: [] }; let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8790','--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000); await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const waitEval = async (expr, label, timeout = 30000) => { const dl = Date.now() + timeout; while (Date.now() < dl) { try { if (await cdp.eval(expr)) { out.steps.push('OK: ' + label); return true; } } catch { /* */ } await sleep(250); } throw new Error('timeout ' + label); };
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
    // 装探针
    await cdp.eval(`(function(){
      window.__probe = { resizeN: 0, innerW: [], beforeprint: 0, afterprint: 0, mqN: 0, mqMatches: [], frames: 0 };
      window.addEventListener('resize', function(){ window.__probe.resizeN++; window.__probe.innerW.push(window.innerWidth); });
      window.addEventListener('beforeprint', function(){ window.__probe.beforeprint++; });
      window.addEventListener('afterprint', function(){ window.__probe.afterprint++; });
      var mq = window.matchMedia('print');
      if (mq.addEventListener) mq.addEventListener('change', function(e){ window.__probe.mqN++; window.__probe.mqMatches.push(e.matches); });
      (function tick(){ window.__probe.frames++; window.requestAnimationFrame(tick); })();
      return true;
    })()`);
    out.before = await cdp.eval('(function(){ var cv=document.querySelector(".print-chart canvas"); return { innerW: window.innerWidth, probe: window.__probe, canvas: cv ? { w: cv.width, h: cv.height, cssW: Math.round(cv.getBoundingClientRect().width) } : null }; })()');
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(ROOT + '/.probe/p3-probe4.pdf', Buffer.from(pdf.data, 'base64'));
    await sleep(1200);
    out.after = await cdp.eval('(function(){ var cv=document.querySelector(".print-chart canvas"); return { innerW: window.innerWidth, probe: window.__probe, canvas: cv ? { w: cv.width, h: cv.height, cssW: Math.round(cv.getBoundingClientRect().width) } : null }; })()');
    out.ok = true;
  } catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
  finally { try { chrome.kill(); } catch { /* */ } try { if (preview) preview.kill(); } catch { /* */ } console.log(JSON.stringify(out, null, 2)); }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
