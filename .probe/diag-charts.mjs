/**
 * diag-charts.mjs —— 定位「报表图表打印为空框」：屏幕态 vs 打印态对比。
 *
 * 背景：p0-verify.mjs 用「PDF 里 /Subtype /Image 计数」当作「有图」的证据，
 * 这是一个**坏代理**——ECharts 画布即使只画了坐标轴、没有数据系列，
 * 也会被 Chrome 光栅化成一个位图对象。真实观感必须render出来看。
 *
 * 本脚本：只勾选 3 张图（取消 4 张表）→ 依次取三种证据
 *   1) 屏幕媒体截图（正常渲染长什么样）
 *   2) print 媒体模拟截图（打印样式下长什么样）
 *   3) Page.printToPDF 产物
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9455;
const XLSX_SAMPLE = 'E:/tools/Hogo-QA-tool/.probe/p0-sample.xlsx';
const OUT_PDF = 'E:/tools/Hogo-QA-tool/.probe/diag.pdf';
const OUT_SCREEN = 'E:/tools/Hogo-QA-tool/.probe/diag-screen.png';
const OUT_PRINTMEDIA = 'E:/tools/Hogo-QA-tool/.probe/diag-printmedia.png';
const OUT_JSON = 'E:/tools/Hogo-QA-tool/.probe/diag-result.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          return null;
        }
      }
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-diag-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const servers = [];
  const startServer = async (args, url, label) => {
    const proc = spawn(process.execPath, args, { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    servers.push(proc);
    await waitForHttp(url, 30000);
    console.log('服务就绪 ' + label);
  };
  await startServer(
    ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server', '--host', '127.0.0.1', '--port', '8787', '--strictPort'],
    'http://127.0.0.1:8787/',
    'preview 8787',
  );

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  const report = { steps: [], checks: {} };
  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    const waitEval = async (expr, label, timeout = 25000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };
    const spaNav = async (href, predicate, label) => {
      await cdp.eval(`(() => { const a=[...document.querySelectorAll('a[href="${href}"]')][0]; if(!a) return false; a.click(); return true; })()`);
      await waitEval(predicate, label);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", '应用加载');

    // 真实 xlsx 导入（含不良 sheet）
    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '导入页');
    await waitEval("!!document.querySelector('input[type=file]')", '文件输入就绪');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { files: [XLSX_SAMPLE], nodeId: found.nodeId });
    await waitEval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()", '解析完成');
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()");
    await waitEval("location.pathname==='/capability' || document.body.innerText.includes('Cpk')", '导入完成');

    // 报表页：只留 3 张图，取消 4 张表（顺带验证按项生效）
    await spaNav('/report', "!!document.querySelector('[data-testid=\"report-page\"]')", '报表页');
    await waitEval("!!document.querySelector('[data-testid=\"report-charts\"]')", '图表区出现');
    for (const k of ['cpkSummary', 'defectStats', 'rawDimensions', 'rawDefects']) {
      await cdp.eval(`(() => { const el=document.querySelector('[data-testid="export-option-${k}"] input'); if (el && el.checked) el.click(); return true; })()`);
    }
    await waitEval("document.querySelectorAll('[data-testid=\"report-charts\"] canvas').length >= 3", '三张图就绪');

    // 关键：量出每个 canvas 的「非空白像素占比」，判断系列到底画没画
    const measure = async (tag) => {
      const data = await cdp.eval(`(() => {
        const out = [];
        for (const cv of document.querySelectorAll('[data-testid="report-charts"] canvas')) {
          const ctx = cv.getContext('2d');
          let stat = { w: cv.width, h: cv.height, drawn: null };
          try {
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            let nonWhite = 0, total = 0;
            for (let i = 0; i < d.length; i += 4 * 17) {
              total += 1;
              if (!(d[i] > 248 && d[i+1] > 248 && d[i+2] > 248) && d[i+3] > 8) nonWhite += 1;
            }
            stat.drawn = +(nonWhite / total).toFixed(4);
          } catch (e) { stat.drawn = 'ERR:' + e.message; }
          out.push(stat);
        }
        return out;
      })()`);
      report.checks['canvases_' + tag] = data;
      return data;
    };

    await sleep(1500);
    await measure('screen');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(OUT_SCREEN, Buffer.from(shot.data, 'base64'));
    report.steps.push('OK: 屏幕截图');

    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(2000);
    await measure('printMedia');
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(OUT_PRINTMEDIA, Buffer.from(shot2.data, 'base64'));
    report.steps.push('OK: print 媒体截图');
    await cdp.send('Emulation.setEmulatedMedia', { media: '' });

    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(OUT_PDF, Buffer.from(pdf.data, 'base64'));
    report.steps.push('OK: printToPDF');

    report.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    for (const s of servers) { try { s.kill(); } catch { /* ignore */ } }
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((e) => { console.error('DIAG FAILED:', e); process.exit(1); });