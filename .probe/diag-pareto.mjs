/**
 * diag-pareto.mjs —— 逐图取证：把每张图单独裁图（视口裁剪，canvas 可靠），
 * 并与「柏拉图」独立页对比，判断是「图表组件坏了」还是「报表页接线坏了」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9466;
const XLSX_SAMPLE = 'E:/tools/Hogo-QA-tool/.probe/p0-sample.xlsx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      }
    });
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

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-dp-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const servers = [];
  const startServer = async (args, url, label) => {
    const proc = spawn(process.execPath, args, { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    servers.push(proc); await waitForHttp(url, 30000); console.log('服务就绪 ' + label);
  };
  await startServer(['node_modules/vite/bin/vite.js','preview','--outDir','dist-server','--host','127.0.0.1','--port','8787','--strictPort'], 'http://127.0.0.1:8787/', 'preview');
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*',`--remote-debugging-port=${CDP_PORT}`,`--user-data-dir=${profile}`,'--window-size=1400,1000','about:blank'], { stdio: 'ignore' });

  const out = { steps: [], measurements: {} };
  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    const waitEval = async (expr, label, timeout = 25000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { if (await cdp.eval(expr)) { out.steps.push('OK: ' + label); return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };
    const spaNav = async (href, predicate, label) => {
      await cdp.eval(`(() => { const a=[...document.querySelectorAll('a[href="${href}"]')][0]; if(!a) return false; a.click(); return true; })()`);
      await waitEval(predicate, label);
    };
    /** 裁剪指定元素的截图（视口内滚动 + clip，canvas 可靠）。 */
    const clipShot = async (selector, file) => {
      const box = await cdp.eval(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; })()`);
      if (!box || box.w < 5 || box.h < 5) throw new Error('元素不可见: ' + selector);
      await sleep(900);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      out.steps.push('OK: 裁图 ' + file);
      return box;
    };
    /** 统计容器内所有 canvas 的「非白像素占比」。 */
    const inkRatio = async (container) => cdp.eval(`(() => {
      const root = document.querySelector(${JSON.stringify(container)});
      if (!root) return null;
      const res = [];
      for (const cv of root.querySelectorAll('canvas')) {
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0, total = 0;
        for (let i = 0; i < d.length; i += 4 * 13) { total++; if (d[i+3] > 8 && !(d[i] > 246 && d[i+1] > 246 && d[i+2] > 246)) ink++; }
        res.push({ w: cv.width, h: cv.height, ink: +(ink / total).toFixed(4) });
      }
      return res;
    })()`);

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", '应用加载');
    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '导入页');
    await waitEval("!!document.querySelector('input[type=file]')", '文件输入就绪');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { files: [XLSX_SAMPLE], nodeId: found.nodeId });
    await waitEval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()", '解析完成');
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()");
    await waitEval("location.pathname==='/capability' || document.body.innerText.includes('Cpk')", '导入完成');

    // ---- A) 独立「柏拉图」页（对照组）----
    await spaNav('/pareto', "document.body.innerText.includes('柏拉图')", '柏拉图独立页');
    await sleep(1800);
    out.measurements.paretoPage = await inkRatio('body');
    await clipShot('[data-testid="pareto-chart"]', 'E:/tools/Hogo-QA-tool/.probe/shot-pareto-page.png');
    const pdfA = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/pareto-page.pdf', Buffer.from(pdfA.data, 'base64'));

    // ---- B) 报表页（被测对象）----
    await spaNav('/report', "!!document.querySelector('[data-testid=\"report-page\"]')", '报表页');
    await waitEval("!!document.querySelector('[data-testid=\"report-charts\"]')", '图表区出现');
    for (const k of ['cpkSummary','defectStats','rawDimensions','rawDefects']) {
      await cdp.eval(`(() => { const el=document.querySelector('[data-testid="export-option-${k}"] input'); if (el && el.checked) el.click(); return true; })()`);
    }
    await waitEval("document.querySelectorAll('[data-testid=\"report-charts\"] canvas').length >= 3", '三张图就绪');
    await sleep(2000);
    out.measurements.reportCharts = await inkRatio('[data-testid="report-charts"]');
    await clipShot('[data-testid="control-chart"]', 'E:/tools/Hogo-QA-tool/.probe/shot-rp-control.png');
    await clipShot('[data-testid="pareto-chart"]', 'E:/tools/Hogo-QA-tool/.probe/shot-rp-pareto.png');
    await clipShot('[data-testid="histogram-chart"]', 'E:/tools/Hogo-QA-tool/.probe/shot-rp-capability.png');
    const pdfB = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/report-charts-only.pdf', Buffer.from(pdfB.data, 'base64'));

    out.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    for (const s of servers) { try { s.kill(); } catch { /* ignore */ } }
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/diag-pareto-result.json', JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });