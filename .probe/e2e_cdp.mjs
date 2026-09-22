/**
 * e2e_cdp.mjs —— 真实 Chrome + CDP 端到端验证（QA 独立实证，非 jsdom）。
 *
 * 场景（服务版 http://127.0.0.1:8787/）：
 *   1) 无 Key 的本地 Ollama：Base URL=http://127.0.0.1:11434/v1，API Key 留空，模型=qwen3.5:9b
 *   2) 设置页应进入「AI 模式」（证明 D3：无 Key 不再被误判离线）
 *   3) 导入测量数据 → AI 助手页点「解读当前控制图」→ 必须拿到非空正文（证明 D1：不再被截断）
 *
 * 约束：使用真实 Chrome；**不**加 --allow-file-access-from-files；加 --no-proxy-server 绕过本机代理。
 * 证据：捕获发往 127.0.0.1:11434 的请求体与响应体原文、页面 DOM 正文、控制台报错。
 *
 * 注意：页面间用**侧栏 SPA 导航**（点击 NavLink），避免整页刷新清空内存中的 zustand 数据集。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 30; i += 1) {
    const v = (10.0 + Math.sin(i * 0.7) * 0.06 + (i % 5) * 0.004).toFixed(3);
    rows.push(`外壳长度,${v},10.3,9.7`);
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
    if (r.exceptionDetails) {
      throw new Error(
        'eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails),
      );
    }
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-e2e-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server', // 关键：绕过本机 HTTP 代理，保证 loopback 直连
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = { chrome: CHROME, steps: [], network: [], console: [], pageErrors: [] };

  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);

    cdp.on('Runtime.consoleAPICalled', (p) => {
      report.console.push(p.type + ': ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      report.pageErrors.push(p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails));
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const reqByIs = new Map();
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.request.url.includes(':11434')) {
        reqByIs.set(p.requestId, {
          url: p.request.url,
          method: p.request.method,
          postData: p.request.postData,
        });
      }
    });
    cdp.on('Network.loadingFinished', async (p) => {
      const meta = reqByIs.get(p.requestId);
      if (!meta) return;
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        meta.response = body.body?.slice(0, 4000);
      } catch (e) {
        meta.response = '<取响应体失败: ' + String(e) + '>';
      }
      report.network.push(meta);
    });

    const waitEval = async (expr, label, timeout = 25000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await cdp.eval(expr)) {
            report.steps.push('OK: ' + label);
            return true;
          }
        } catch {
          /* retry */
        }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };

    // 首次整页加载
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval(
      "!!document.querySelector('[data-testid=\"import-page\"]') || document.body.innerText.includes('Hogo-QA-tool')",
      '应用首页加载',
    );

    // SPA 导航（点击侧栏 NavLink，保留内存状态）
    const spaNav = async (href, predicate, label, timeout = 25000) => {
      const clicked = await cdp.eval(
        `(() => { const a=[...document.querySelectorAll('a[href="${href}"]')][0]; if(!a) return false; a.click(); return true; })()`,
      );
      if (!clicked) throw new Error('未找到侧栏导航链接: ' + href);
      await waitEval(predicate, label, timeout);
      report.steps.push('SPA→ ' + label);
    };

    // 1) 设置页：填 Base URL / 模型名，API Key 留空 → 应进入 AI 模式（D3）
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", '设置页');
    const setInput = (aria, val) =>
      cdp.eval(
        `(() => { const el=document.querySelector('input[aria-label=${JSON.stringify(aria)}]'); if(!el) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`,
      );
    await setInput('Base URL', 'http://127.0.0.1:11434/v1');
    await setInput('模型名', 'qwen3.5:9b');
    await setInput('API Key', ''); // 明确留空
    await waitEval(
      "(() => { const c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return !!c && c.textContent.includes('AI 模式'); })()",
      '设置页进入 AI 模式（无 Key 探测成功）',
      30000,
    );
    report.modeChip = await cdp.eval("document.querySelector('[data-testid=\"settings-mode-chip\"]').textContent");

    // 2) 导入数据（SPA → 粘贴 CSV → 解析 → 确认导入）
    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '数据导入页');
    await cdp.eval(
      "(() => { const t=[...document.querySelectorAll('.MuiTab-root')].find(e=>e.textContent.includes('粘贴 CSV')); if(!t) return false; t.click(); return true; })()",
    );
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", '粘贴输入框出现');
    await cdp.eval(
      `(() => { const el=document.querySelector('textarea[data-testid="paste-input"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, ${JSON.stringify(CSV)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length; })()`,
    );
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='解析'); if(!b) return false; b.click(); return true; })()",
    );
    await waitEval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()",
      '「确认导入并分析」可点击',
      20000,
    );
    report.importStats = await cdp.eval("document.body.innerText.match(/特性数[\\s\\S]{0,40}/)?.[0] ?? null");
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()",
    );
    await waitEval(
      "document.body.innerText.includes('Cpk') || !!document.querySelector('[data-testid=\"capability-page\"]') || location.pathname==='/capability'",
      '导入后到达分析页',
      20000,
    );

    // 3) AI 助手页：点「解读当前控制图」
    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'AI 助手页（非离线门控）');
    await waitEval(
      "(() => { const b=document.querySelector('[data-testid=\"ai-action-chartExplain\"]'); return !!b && !b.disabled; })()",
      '「解读当前控制图」可点击（数据集已在）',
      20000,
    );
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-chartExplain\"]').click()");

    const deadline = Date.now() + 150000;
    let convo = '';
    while (Date.now() < deadline) {
      convo = await cdp.eval(
        "(() => { const c=document.querySelector('[data-testid=\"ai-conversation\"]'); return c ? c.innerText : ''; })()",
      );
      const stripped = convo
        .replace(/AI 助手|我|复制|已复制|已发送：仅摘要|发送字段：[^\n]*/g, '')
        .trim();
      if (stripped.length > 30) break;
      await sleep(1500);
    }
    report.conversation = convo;
    report.scopeChip = await cdp.eval(
      "(() => { const c=document.querySelector('[data-testid=\"ai-scope-chip\"]'); return c ? c.textContent : null; })()",
    );
    report.finalUrl = await cdp.eval('location.href');

    console.log('\n================ E2E 结果 ================');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('E2E 失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
