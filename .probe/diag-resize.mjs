/**
 * diag-resize.mjs —— 验证假设：「ECharts 入场动画期间画布是空的，
 * 打印时 Chrome 会改变视口宽度 → 触发 resize → ECharts 重绘并重新播放动画
 * → 若此时光栅化，就会得到一张只有坐标轴、没有数据系列的『空图』」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const FILE_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9488;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CSV = (() => {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 50; i += 1) rows.push(`外壳长度,${(50 + Math.sin(i * 0.7) * 0.03).toFixed(4)},50.2,49.8`);
  for (let i = 0; i < 50; i += 1) rows.push(`转轴直径,${(12 + Math.sin(i * 0.7) * 0.006).toFixed(4)},12.02,11.98`);
  return rows.join('\n');
})();

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
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
}

const INK = `(() => {
  const res = [];
  for (const cv of document.querySelectorAll('[data-testid="report-charts"] canvas')) {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let colored = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      if (d[i+3] > 40 && mx - mn > 45 && mx > 70) colored += 1;
    }
    res.push(colored);
  }
  return res;
})()`;

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-rz-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--allow-file-access-from-files',`--remote-debugging-port=${CDP_PORT}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore' });
  const out = { steps: [], measurements: {} };
  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    const waitEval = async (expr, label, timeout = 25000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { try { if (await cdp.eval(expr)) { out.steps.push('OK: ' + label); return true; } } catch { /* retry */ } await sleep(250); }
      throw new Error('等待超时: ' + label);
    };
    const nav = async (route, predicate, label) => {
      await cdp.eval(`(() => { const a=[...document.querySelectorAll('a')].find(e=>(e.getAttribute('href')||'').includes(${JSON.stringify(route)})); if(!a) return false; a.click(); return true; })()`);
      await waitEval(predicate, label);
    };

    await cdp.send('Page.navigate', { url: FILE_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", '离线包加载');
    await nav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '导入页');
    await cdp.eval("(() => { const t=[...document.querySelectorAll('.MuiTab-root')].find(e=>e.textContent.includes('粘贴 CSV')); if(t) t.click(); return true; })()");
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", '粘贴框');
    await cdp.eval(`(() => { const el=document.querySelector('textarea[data-testid="paste-input"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, ${JSON.stringify(CSV)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='解析'); b.click(); return true; })()");
    await waitEval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()", '解析完成');
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()");
    await waitEval("document.body.innerText.includes('Cpk')", '导入完成');
    await nav('/report', "document.body.innerText.includes('一键质量日报导出')", '报表页');
    await waitEval("document.querySelectorAll('[data-testid=\"report-charts\"] canvas').length >= 3", '三张图就绪');

    await sleep(2500);
    out.measurements.settled = await cdp.eval(INK);

    // 模拟打印时的重新布局：改变宽度触发 resize
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    out.measurements.rightAfterResize = await cdp.eval(INK);
    await sleep(300);
    out.measurements.after300ms = await cdp.eval(INK);
    await sleep(1200);
    out.measurements.after1500ms = await cdp.eval(INK);
    out.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/diag-resize-result.json', JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });