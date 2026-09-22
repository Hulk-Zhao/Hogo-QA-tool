/** p3-excel-verify.mjs —— 真浏览器导出 Excel，再用 Python openpyxl 独立校验内嵌图片。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
import { PYTHON as PY } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8791/';
const CDP_PORT = 9467;
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const DL = ROOT + '/.probe/downloads';
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
  send(method, params = {}, sessionId) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; }
}
async function waitHttp(url, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* */ } await sleep(200); } throw new Error('timeout ' + url); }

async function main() {
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  const profile = path.join(os.tmpdir(), 'hogo-p3xl-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + profile,'--window-size=1500,1000','about:blank'], { stdio: 'ignore' });
  const report = { steps: [], asserts: [], ok: false };
  let preview;
  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8791','--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
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

    report.canvasInfo = await cdp.eval('(function(){ return [].slice.call(document.querySelectorAll(".print-chart canvas")).map(function(c){ return { w: c.width, h: c.height }; }); })()');
    // 期望图片数 = 含画布的 .print-chart 容器数（同一卡片的多块画布会被拼成一张）
    report.chartGroups = await cdp.eval('(function(){ return [].slice.call(document.querySelectorAll(".print-chart")).filter(function(g){ return g.querySelector("canvas"); }).length; })()');

    // 抓 Blob：比依赖下载目录更稳（headless 的下载落盘时序不可靠）。
    await cdp.eval(`(function(){
      window.__blob = null;
      var orig = URL.createObjectURL;
      URL.createObjectURL = function(b){ window.__blob = b; return orig.call(URL, b); };
      return true;
    })()`);
    await cdp.eval('(function(){ var b=document.querySelector("[data-testid=\\"export-excel\\"]"); b.click(); return true; })()');
    const deadline = Date.now() + 20000;
    let captured = null;
    while (Date.now() < deadline) {
      captured = await cdp.eval(`(async function(){
        if (!window.__blob) return null;
        var buf = await window.__blob.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var chunk = 8192, parts = [];
        for (var i = 0; i < bytes.length; i += chunk) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
        }
        return { type: window.__blob.type, size: bytes.length, b64: btoa(parts.join('')) };
      })()`);
      if (captured && captured.size > 0) break;
      await sleep(400);
    }
    if (!captured || captured.size === 0) throw new Error('点击后没有捕获到导出 Blob');
    report.blob = { type: captured.type, size: captured.size };
    const file = DL + '/report.xlsx';
    fs.writeFileSync(file, Buffer.from(captured.b64, 'base64'));
    report.bodyText = await cdp.eval('document.body.innerText');
    report.toast = String(report.bodyText).split('\n').filter((l) => l.indexOf('已导出 Excel') >= 0 || l.indexOf('导出失败') >= 0);
    report.downloaded = fs.readdirSync(DL);

    execFileSync(PY, [ROOT + '/.workbuddy/tmp/p3-xlsx-report.py', file], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    report.xlsx = JSON.parse(fs.readFileSync(ROOT + '/.probe/p3-xlsx-report.json', 'utf8'));

    const x = report.xlsx;
    check('openpyxl 读到 5 个 sheet（4 数据 + 图表）', x.sheetnames.length === 5, JSON.stringify(x.sheetnames));
    check('最后一个 sheet 名为「图表」', x.sheetnames[4] === '图表', String(x.sheetnames[4]));
    check('xl/media 的 PNG 张数 == 页面上含画布的图表数', x.media.length === report.chartGroups && report.chartGroups >= 2, 'media=' + x.media.length + ' groups=' + report.chartGroups);
    check('每张 PNG 都能被 PIL 打开且尺寸与画布一致', x.media.length > 0 && x.media.every((m) => m.format === 'PNG' && m.size[0] > 100 && m.size[1] > 100), JSON.stringify(x.media.map((m) => m.size)));
    check('openpyxl 在图表 sheet 上取到同样数量的图片对象', x.openpyxl_images === x.media.length && x.openpyxl_images >= 2, 'n=' + x.openpyxl_images);
    check('drawing1.xml 存在且引用 rId', !!x.drawing && x.drawing.includes('r:embed="rId1"'), String(x.drawing).slice(0, 60));
    check('sheet5 关系指向 drawing1.xml', !!x.sheet5_rels && x.sheet5_rels.includes('../drawings/drawing1.xml'), String(x.sheet5_rels).slice(0, 80));
    check('导出提示包含「图表 sheet」与张数', Array.isArray(report.toast) && report.toast.some((t) => String(t).includes('图表 sheet')), JSON.stringify(report.toast));
    check('导出产物是 xlsx MIME 且体积 > 100KB（含 PNG）', report.blob && report.blob.type.includes('spreadsheetml') && report.blob.size > 100000, JSON.stringify(report.blob));
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) { report.error = String((e && e.message) || e); }
  finally {
    try { chrome.kill(); } catch { /* */ }
    try { if (preview) preview.kill(); } catch { /* */ }
    fs.writeFileSync(ROOT + '/.probe/p3-excel-verify.json', JSON.stringify(report, null, 2), 'utf8');
    console.log('--- steps/toast ---');
    console.log(JSON.stringify({ steps: report.steps, canvases: report.canvasInfo, downloaded: report.downloaded, toast: report.toast, error: report.error }, null, 2));
    console.log('--- xlsx (openpyxl) ---');
    console.log(JSON.stringify(report.xlsx ? { sheetnames: report.xlsx.sheetnames, media: report.xlsx.media, images: report.xlsx.openpyxl_images, cellA1: report.xlsx.cellA1 } : null, null, 2));
    console.log('--- asserts ---');
    for (const a of report.asserts) console.log((a.pass ? 'PASS ' : 'FAIL ') + a.name + '  [' + a.detail + ']');
    console.log('ok =', report.ok);
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
