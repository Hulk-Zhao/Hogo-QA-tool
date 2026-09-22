/**
 * repro-400.mjs —— 复现用户报障「请求内容被服务端拒绝，请检查模型名与参数。（HTTP 400）」。
 *
 * 场景：Base URL 指向**真实本机 Ollama**（不是 mock），但「模型名」留空。
 * 目的：拿到 (a) 浏览器实际发出的请求体、(b) 服务端返回的真实 HTTP 状态与响应原文、
 *       (c) 应用 UI 最终展示给用户的文案 —— 三者对齐才能定位根因。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9445;
const OUT = 'E:/tools/Hogo-QA-tool/.probe/repro-400-result.json';
const MODEL = process.env.REPRO_MODEL ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) {
    const v = (50 + Math.sin(i * 0.7) * 0.03).toFixed(4);
    rows.push('外壳长度,' + v + ',50.2,49.8');
  }
  return rows.join('\n');
}
const CSV = buildCsv();

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('timeout waiting: ' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-repro400-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  const report = { model: MODEL, steps: [], checks: {}, pageErrors: [], consoleErrors: [] };
  let preview;
  try {
    preview = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server',
      '--host', '127.0.0.1', '--port', '8787', '--strictPort',
    ], { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    await waitForHttp(APP_URL, 30000);
    report.steps.push('OK: vite preview 8787');
    await waitForHttp('http://127.0.0.1:11434/api/version', 15000);
    report.steps.push('OK: real Ollama 11434');

    await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => report.pageErrors.push(
      p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails)));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') report.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });

    const netResponses = [];
    cdp.on('Network.responseReceived', (p) => {
      if (p.response && p.response.url.includes('/chat/completions')) {
        netResponses.push({ requestId: p.requestId, url: p.response.url, status: p.response.status });
      }
    });
    const netRequests = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.request && p.request.url.includes('/chat/completions')) {
        netRequests.push({ url: p.request.url, postData: p.request.postData ?? null });
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const waitEval = async (expr, label, timeout = 25000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('wait timeout: ' + label);
    };
    const spaNav = async (href, predicate, label) => {
      const clicked = await cdp.eval(
        '(function(){ var a=[].slice.call(document.querySelectorAll(\'a[href="' + href + '"]\'))[0]; if(!a) return false; a.click(); return true; })()');
      if (!clicked) throw new Error('no nav link: ' + href);
      await waitEval(predicate, label);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", 'app loaded');

    // 导入数据（AI 摘要需要项目数据）
    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", 'import page');
    await cdp.eval("(function(){ var t=[].slice.call(document.querySelectorAll('.MuiTab-root')).filter(function(e){return e.textContent.indexOf('粘贴 CSV')>=0;})[0]; if(t) t.click(); return true; })()");
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", 'paste input');
    await cdp.eval(
      "(function(){ var el=document.querySelector('textarea[data-testid=\"paste-input\"]'); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, " + JSON.stringify(CSV) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length; })()");
    await cdp.eval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='解析';})[0]; b.click(); return true; })()");
    await waitEval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='确认导入并分析';})[0]; return !!b && !b.disabled; })()", 'confirm enabled', 20000);
    await cdp.eval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='确认导入并分析';})[0]; b.click(); return true; })()");
    await waitEval("document.body.innerText.indexOf('Cpk')>=0", 'imported', 20000);

    // 指向真实 Ollama，模型名留空（用户报障现场）
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'settings page');
    const setInput = (aria, val) => cdp.eval(
  "(function(a,v){ try { var el=[].slice.call(document.querySelectorAll('input')).filter(function(e){return e.getAttribute('aria-label')===a;})[0]; if(!el) return 'NO_EL:' + a; var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; } catch(e){ return 'ERR:' + e.message; } })("
    + JSON.stringify(aria) + "," + JSON.stringify(val) + ")",
);
report.checks.ariaLabels = await cdp.eval("(function(){ return [].slice.call(document.querySelectorAll('input[aria-label]')).map(function(e){return e.getAttribute('aria-label');}); })()");
    await setInput('Base URL', 'http://127.0.0.1:11434/v1');
    await setInput('API Key', '');
    await setInput('模型名', MODEL);
    await sleep(1500);
    report.checks.settingsRaw = await cdp.eval("localStorage.getItem('hogo-qa-settings')");

    await waitEval("(function(){ var c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return !!c && c.textContent.indexOf('AI 模式')>=0; })()", 'mode chip = AI 模式', 30000).catch(async () => {
      report.checks.modeChipText = await cdp.eval("(function(){ var c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return c ? c.textContent : null; })()");
    });
    report.checks.modeChipText = await cdp.eval("(function(){ var c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return c ? c.textContent : null; })()");

    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'ai page');
    report.checks.gateDisabled = await cdp.eval("!!document.querySelector('[data-testid=\"ai-gate-disabled\"]')");
    await waitEval("(function(){ var b=document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]'); return !!b && !b.disabled; })()", 'fullDiagnosis clickable', 20000);
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]').click()");
    await sleep(6000);

    report.checks.conversationText = await cdp.eval("(function(){ var c=document.querySelector('[data-testid=\"ai-conversation\"]'); return c ? c.innerText.slice(0,900) : null; })()");
    report.checks.hasDiagnosisCard = await cdp.eval("!!document.querySelector('[data-testid=\"ai-full-diagnosis\"]')");
    report.checks.netRequestPostData = netRequests.map((r) => r.postData);
    report.checks.netResponseStatus = netResponses.map((r) => r.status);
    for (const r of netResponses) {
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: r.requestId });
        report.checks.serverResponseBody = body.body.slice(0, 600);
      } catch (e) { report.checks.serverResponseBody = 'ERR ' + String(e).slice(0, 160); }
    }
    report.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { preview?.kill(); } catch { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }, null, 2), 'utf8');
  console.error('REPRO FAILED:', err);
  process.exit(1);
});