/**
 * e2e_file.mjs —— 真实 Chrome + `file://` 双击版端到端验证（QA 独立实证）。
 *
 * 目标页面：file:///E:/tools/Hogo-QA-tool/dist/index.html（离线单文件版，HashRouter）
 * 约束：**不加** --allow-file-access-from-files；加 --no-proxy-server。
 *
 * 验证：
 *   b1) 配置本机 Ollama（Base URL=http://127.0.0.1:11434/v1，Key 留空，qwen3.5:9b）
 *       → 因已设 OLLAMA_ORIGINS=*，file:// 也应能进入 AI 模式并拿到非空正文。
 *   b2) 把 Base URL 指向不可达的本机端口 → 点「连通性测试」→ 设置页应给出 D2 的
 *       可操作提示（含 OLLAMA_ORIGINS=* 与 start.bat 两条出路）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9334;

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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
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
  const profile = path.join(os.tmpdir(), 'hogo-e2e-file-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = { chrome: CHROME, url: APP_URL, steps: [], network: [], console: [], pageErrors: [] };

  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
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
        reqByIs.set(p.requestId, { url: p.request.url, method: p.request.method, postData: p.request.postData });
      }
    });
    cdp.on('Network.loadingFinished', async (p) => {
      const meta = reqByIs.get(p.requestId);
      if (!meta) return;
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        meta.response = body.body?.slice(0, 3500);
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

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval(
      "!!document.querySelector('[data-testid=\"import-page\"]') || !!document.querySelector('[data-testid=\"app-sidebar\"]')",
      'file:// 应用加载',
      20000,
    );
    report.protocol = await cdp.eval('location.protocol');
    report.href = await cdp.eval('location.href');

    // 侧栏 SPA 导航（HashRouter 下 href 形如 #/settings，故按文本匹配）
    const spaNav = async (label, predicate, timeout = 25000) => {
      const clicked = await cdp.eval(
        `(() => { const a=[...document.querySelectorAll('[data-testid="app-sidebar"] a')].find(e=>e.textContent.trim().includes(${JSON.stringify(label)})); if(!a) return false; a.click(); return true; })()`,
      );
      if (!clicked) throw new Error('未找到侧栏链接: ' + label);
      await waitEval(predicate, label, timeout);
    };

    const setInput = (aria, val) =>
      cdp.eval(
        `(() => { const el=document.querySelector('input[aria-label=${JSON.stringify(aria)}]'); if(!el) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`,
      );

    // —— b1：file:// 直连本机 Ollama（OLLAMA_ORIGINS=*）——
    await spaNav('设置', "!!document.querySelector('[data-testid=\"settings-page\"]')");
    await setInput('Base URL', 'http://127.0.0.1:11434/v1');
    await setInput('模型名', 'qwen3.5:9b');
    await setInput('API Key', '');
    await waitEval(
      "(() => { const c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return !!c && c.textContent.includes('AI 模式'); })()",
      'file:// 进入 AI 模式（OLLAMA_ORIGINS=*）',
      30000,
    );
    report.modeChip = await cdp.eval("document.querySelector('[data-testid=\"settings-mode-chip\"]').textContent");

    await spaNav('数据导入', "!!document.querySelector('[data-testid=\"import-page\"]')");
    await cdp.eval(
      "(() => { const t=[...document.querySelectorAll('.MuiTab-root')].find(e=>e.textContent.includes('粘贴 CSV')); if(!t) return false; t.click(); return true; })()",
    );
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", '粘贴输入框');
    await cdp.eval(
      `(() => { const el=document.querySelector('textarea[data-testid="paste-input"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, ${JSON.stringify(CSV)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length; })()`,
    );
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='解析'); if(!b) return false; b.click(); return true; })()",
    );
    await waitEval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()",
      '确认导入可点击',
      20000,
    );
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()",
    );
    await waitEval("location.hash.includes('/capability') || document.body.innerText.includes('Cpk')", '到达分析页', 20000);

    await spaNav('AI 助手', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')");
    await waitEval(
      "(() => { const b=document.querySelector('[data-testid=\"ai-action-chartExplain\"]'); return !!b && !b.disabled; })()",
      '解读按钮可点击',
      20000,
    );
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-chartExplain\"]').click()");

    const deadline = Date.now() + 150000;
    let convo = '';
    while (Date.now() < deadline) {
      convo = await cdp.eval(
        "(() => { const c=document.querySelector('[data-testid=\"ai-conversation\"]'); return c ? c.innerText : ''; })()",
      );
      const stripped = convo.replace(/AI 助手|我|复制|已复制|已发送：仅摘要|发送字段：[^\n]*/g, '').trim();
      if (stripped.length > 30) break;
      await sleep(1500);
    }
    report.conversation = convo;

    // —— b2：D2 提示（不可达本机地址 + 连通性测试失败）——
    await spaNav('设置', "!!document.querySelector('[data-testid=\"settings-page\"]')");
    await setInput('Base URL', 'http://127.0.0.1:59999/v1');
    report.baseUrlAfterSet = await cdp.eval(
      "document.querySelector('input[aria-label=\"Base URL\"]').value",
    );
    const clickedTest = await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='连通性测试'); if(!b) return 'NO_BTN'; if(b.disabled) return 'DISABLED'; b.click(); return 'CLICKED'; })()",
    );
    report.connectivityClick = clickedTest;
    await waitEval(
      "(() => { const f=document.querySelector('[data-testid=\"settings-test-fail\"]'); const o=document.querySelector('[data-testid=\"settings-test-ok\"]'); return !!f || !!o; })()",
      '连通性测试出结果',
      30000,
    );
    report.testFailAlert = await cdp.eval(
      "(() => { const a=document.querySelector('[data-testid=\"settings-test-fail\"]'); return a ? a.innerText : null; })()",
    );
    report.testOkAlert = await cdp.eval(
      "(() => { const a=document.querySelector('[data-testid=\"settings-test-ok\"]'); return a ? a.innerText : null; })()",
    );
    report.d2Hint = await cdp.eval(
      "(() => { const i=document.body.innerText.indexOf('当前是双击打开的离线版'); return i>=0 ? document.body.innerText.slice(i, i+180) : null; })()",
    );
    report.modeChipAfterFail = await cdp.eval(
      "(() => { const c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return c ? c.textContent : null; })()",
    );

    console.log('\n================ FILE:// E2E 结果 ================');
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
  console.error('file:// E2E 失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
