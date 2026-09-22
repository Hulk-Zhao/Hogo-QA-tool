/**
 * diag-stale.mjs —— 复现用户报告的现象：从离线包 dist/index.html 打印报表。
 * 目的：判定「用户运行的是修复前的旧产物」这一假设是否成立（可证伪）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const FILE_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9477;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  const push = (n, base, usl, lsl, amp) => {
    for (let i = 0; i < 50; i += 1) {
      rows.push(`${n},${(base + Math.sin(i * 0.7) * amp + (i % 5) * 0.003).toFixed(4)},${usl},${lsl}`);
    }
  };
  push('外壳长度', 50.0, 50.2, 49.8, 0.03);
  push('转轴直径', 12.0, 12.02, 11.98, 0.006);
  push('安装孔径', 8.0, 8.1, 7.9, 0.02);
  return rows.join('\n');
}
const CSV = buildCsv();

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
  const profile = path.join(os.tmpdir(), 'hogo-stale-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-proxy-server','--remote-allow-origins=*','--allow-file-access-from-files',`--remote-debugging-port=${CDP_PORT}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore' });
  const out = { steps: [], checks: {} };
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
      while (Date.now() < deadline) {
        try { if (await cdp.eval(expr)) { out.steps.push('OK: ' + label); return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };
    const nav = async (route, predicate, label) => {
      const clicked = await cdp.eval(`(() => { const a=[...document.querySelectorAll('a')].find(e=>(e.getAttribute('href')||'').includes(${JSON.stringify(route)})); if(!a) return false; a.click(); return true; })()`);
      if (!clicked) throw new Error('未找到导航: ' + route);
      await waitEval(predicate, label);
    };

    await cdp.send('Page.navigate', { url: FILE_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", '离线包加载');
    out.checks.protocol = await cdp.eval('location.protocol');

    await nav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '导入页');
    await cdp.eval("(() => { const t=[...document.querySelectorAll('.MuiTab-root')].find(e=>e.textContent.includes('粘贴 CSV')); if(t) t.click(); return true; })()");
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", '粘贴框');
    await cdp.eval(`(() => { const el=document.querySelector('textarea[data-testid="paste-input"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, ${JSON.stringify(CSV)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='解析'); b.click(); return true; })()");
    await waitEval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()", '解析完成');
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()");
    await waitEval("document.body.innerText.includes('Cpk')", '导入完成');

    await nav('/report', "document.body.innerText.includes('一键质量日报导出')", '报表页');
    await sleep(1500);
    out.checks.hasExportOptions = await cdp.eval("!!document.querySelector('[data-testid=\"report-export-options\"]')");
    out.checks.exportOptionCount = await cdp.eval("document.querySelectorAll('[data-testid^=\"export-option-\"]').length");
    out.checks.hasChartArea = await cdp.eval("!!document.querySelector('[data-testid=\"report-charts\"]')");
    out.checks.canvasCount = await cdp.eval("document.querySelectorAll('canvas').length");
    out.checks.sectionTitles = await cdp.eval("(() => { const t=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,.MuiTypography-subtitle1')].map(e=>e.textContent.trim()).filter(Boolean); return t; })()");

    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/stale-offline.pdf', Buffer.from(pdf.data, 'base64'));
    out.checks.pdfBytes = Buffer.from(pdf.data, 'base64').length;

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/stale-offline.png', Buffer.from(shot.data, 'base64'));
    out.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/diag-stale-result.json', JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });