/**
 * ai400-verify.mjs —— AI 诊断 HTTP 400 报障的**真实环境**验收（真 Chrome + 真 Ollama）。
 *
 * 三个场景：
 *   A 空模型名        → 必须不发请求、不进 AI 模式（旧版：进 AI 模式 → 400 → 泛化报错）；
 *   B 模型名写错      → 真 Ollama 404，UI 必须展示服务端原文（model ... not found）；
 *   C 服务端返回 400  → 用**字节级真实**的 Ollama 400 响应体（model is required），
 *                       验证 UI 同时给出「泛化说明 + 服务端原文」。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9446;
const STRICT_PORT = 8901;
const OUT = 'E:/tools/Hogo-QA-tool/.probe/ai400-verify-result.json';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';
/** 本机 Ollama v0.32.7 对空模型名的真实响应体（字节级照搬）。 */
const OLLAMA_400_BODY =
  '{"error":{"message":"model is required","type":"invalid_request_error","param":null,"code":null}}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) {
    rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('timeout waiting: ' + url);
}

/** 严格模拟 Ollama 的 400 服务端（/v1/models 正常，chat 一律 400）。 */
/** 严格模拟 Ollama 的 400 服务端（/v1/models 正常，chat 一律 400）。 */
function startStrictServer(received) {
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url.includes('/models')) {
        res.writeHead(200, cors);
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.5:9b' }] }));
        return;
      }
      // 记录真实请求体：用于确认「去掉 reasoning_effort 的重试」确实发生过。
      try {
        received.push(JSON.parse(raw));
      } catch {
        received.push(raw);
      }
      res.writeHead(400, cors);
      res.end(OLLAMA_400_BODY);
    });
  });
  return new Promise((resolve) => server.listen(STRICT_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-ai400-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const received400 = [];
  const strict = await startStrictServer(received400);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  const report = { steps: [], cases: {}, pageErrors: [], consoleErrors: [] };
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
    report.steps.push('OK: strict-400 server 8901');

    await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => report.pageErrors.push(
      p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails)));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') report.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });

    const chatCalls = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.request && p.request.url.includes('/chat/completions')) {
        chatCalls.push({ url: p.request.url, postData: p.request.postData ?? null });
      }
    });
    const chatResponses = [];
    cdp.on('Network.responseReceived', (p) => {
      if (p.response && p.response.url.includes('/chat/completions')) {
        chatResponses.push({ requestId: p.requestId, status: p.response.status, url: p.response.url });
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
"(function(h){ var a=[].slice.call(document.querySelectorAll('a[href]')).filter(function(e){return e.getAttribute('href')===h;})[0]; if(!a) return false; a.click(); return true; })(" + JSON.stringify(href) + ")");
      if (!clicked) throw new Error('no nav link: ' + href);
      await waitEval(predicate, label);
    };
    const setInput = (aria, val) => cdp.eval(
      "(function(a,v){ try { var el=[].slice.call(document.querySelectorAll('input')).filter(function(e){return e.getAttribute('aria-label')===a;})[0]; if(!el) return 'NO_EL:' + a; var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; } catch(e){ return 'ERR:' + e.message; } })("
        + JSON.stringify(aria) + "," + JSON.stringify(val) + ")");

    /** 最后一个助手气泡（含服务端原文行）。 */
    const lastBubble = `(() => {
      var c = document.querySelector('[data-testid="ai-conversation"]');
      if (!c) return null;
      var kids = [].slice.call(c.children);
      var last = kids[kids.length - 1];
      return last ? last.innerText : null;
    })()`;
    const detailCount = "document.querySelectorAll('[data-testid=\"ai-server-detail\"]').length";
    const lastDetail = `(() => {
      var els = document.querySelectorAll('[data-testid="ai-server-detail"]');
      return els.length ? els[els.length - 1].innerText : null;
    })()`;
    const chipText = "(() => { var c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return c ? c.textContent : null; })()";

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", 'app loaded');

    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", 'import page');
    await cdp.eval("(function(){ var t=[].slice.call(document.querySelectorAll('.MuiTab-root')).filter(function(e){return e.textContent.indexOf('粘贴 CSV')>=0;})[0]; if(t) t.click(); return true; })()");
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", 'paste input');
    await cdp.eval(
      "(function(){ var el=document.querySelector('textarea[data-testid=\"paste-input\"]'); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, " + JSON.stringify(CSV) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length; })()");
    await cdp.eval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='解析';})[0]; b.click(); return true; })()");
    await waitEval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='确认导入并分析';})[0]; return !!b && !b.disabled; })()", 'confirm enabled', 20000);
    await cdp.eval("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(e){return e.textContent.trim()==='确认导入并分析';})[0]; b.click(); return true; })()");
    await waitEval("document.body.innerText.indexOf('Cpk')>=0", 'imported', 20000);

    // ---------------------------------------------------------------- 场景 A
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'settings page');
    await setInput('Base URL', OLLAMA_URL);
    await setInput('API Key', '');
    await setInput('模型名', '');
    await sleep(2500);
    report.cases.A_modeChip = await cdp.eval(chipText);
    const aCallsBefore = chatCalls.length;
    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]') || !!document.querySelector('[data-testid=\"ai-assistant-offline\"]')", 'ai page (A)');
    report.cases.A_gateDisabled = await cdp.eval("!!document.querySelector('[data-testid=\"ai-gate-disabled\"]')");
    report.cases.A_offlinePanel = await cdp.eval("!!document.querySelector('[data-testid=\"ai-assistant-offline\"]')");
    report.cases.A_chatRequests = chatCalls.length - aCallsBefore;
    report.cases.A_conversation = await cdp.eval(lastBubble);

    // ---------------------------------------------------------------- 场景 B
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'settings page (B)');
    await setInput('模型名', 'no-such-model:1b');
    await sleep(2500);
    report.cases.B_modeChip = await cdp.eval(chipText);
    const bCallsBefore = chatCalls.length;
    const bRespBefore = chatResponses.length;
    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'ai page (B)');
    await waitEval("(function(){ var b=document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]'); return !!b && !b.disabled; })()", 'fullDiagnosis clickable (B)', 20000);
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]').click()");
    await waitEval(detailCount + " >= 1", 'server detail rendered (B)', 40000);
    report.cases.B_bubble = await cdp.eval(lastBubble);
    report.cases.B_serverDetail = await cdp.eval(lastDetail);
    report.cases.B_chatRequests = chatCalls.length - bCallsBefore;
    report.cases.B_statuses = chatResponses.slice(bRespBefore).map((r) => r.status);
    {
      const last = chatResponses[chatResponses.length - 1];
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: last.requestId });
        report.cases.B_serverRawBody = body.body.slice(0, 300);
      } catch (e) { report.cases.B_serverRawBody = 'ERR ' + String(e).slice(0, 120); }
    }

    // ---------------------------------------------------------------- 场景 C
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'settings page (C)');
    report.cases.C_setBase = await setInput('Base URL', 'http://127.0.0.1:' + STRICT_PORT + '/v1');
    report.cases.C_setModel = await setInput('模型名', 'qwen3.5:9b');
    await sleep(2500);
    report.cases.C_settingsRaw = await cdp.eval("localStorage.getItem('hogo-qa-settings')");
    report.cases.C_modeChip = await cdp.eval(chipText);
    const cRespBefore = chatResponses.length;
    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'ai page (C)');
    await waitEval("(function(){ var b=document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]'); return !!b && !b.disabled; })()", 'fullDiagnosis clickable (C)', 20000);
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]').click()");
    try {
      await waitEval("(function(){ var els=document.querySelectorAll('[data-testid=\"ai-server-detail\"]'); if(!els.length) return false; return els[els.length-1].innerText.indexOf('model is required')>=0; })()", 'server detail rendered (C)', 45000);
    } catch (e) {
      report.cases.C_waitError = String(e).slice(0, 200);
    }
    report.cases.C_detailCount = await cdp.eval(detailCount);
    report.cases.C_conversationAll = await cdp.eval("(function(){ var c=document.querySelector('[data-testid=\"ai-conversation\"]'); return c ? c.innerText.slice(-700) : null; })()");
    report.cases.C_bubble = await cdp.eval(lastBubble);
    report.cases.C_serverDetail = await cdp.eval(lastDetail);
    report.cases.C_statuses = chatResponses.slice(cRespBefore).map((r) => r.status);
    {
      const last = chatResponses[chatResponses.length - 1];
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: last.requestId });
        report.cases.C_serverRawBody = body.body.slice(0, 300);
      } catch (e) { report.cases.C_serverRawBody = 'ERR ' + String(e).slice(0, 120); }
    }

    report.cases.C_requestBodies = received400.map((b) => (b && b.model !== undefined ? { model: b.model, max_tokens: b.max_tokens, hasReasoningEffort: Object.prototype.hasOwnProperty.call(b, "reasoning_effort") } : String(b).slice(0, 80)));
    // ---------------------------------------------------------------- 场景 D
    // 产物自证版本：真机产物上的构建标识必须是**真实时间戳**而非 'dev'。
    // 若从 vite 配置中删掉 define: { __BUILD_STAMP__ } → 这里读到 'dev' → 变红。
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'settings page (D)');
    report.cases.D_buildStamp = await cdp.eval("(function(){ var el=document.querySelector('[data-testid=\"app-build-stamp\"]'); return el ? el.textContent : null; })()");
    report.cases.D_buildStampInjected = typeof report.cases.D_buildStamp === 'string' && report.cases.D_buildStamp.indexOf('dev') < 0;
    report.ok = true;
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { preview?.kill(); } catch { /* ignore */ }
    try { strict.close(); } catch { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }, null, 2), 'utf8');
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});