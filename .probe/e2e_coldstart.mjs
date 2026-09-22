/**
 * e2e_coldstart.mjs —— 冷启动接线探针（QA 独立实证）。
 *
 * 目的：验证「已保存 AI 配置 + 直接冷启动进入 /ai」时，是否会自动探测并进入 AI 模式。
 * 背景：`useAiAvailability` 唯一调用点是 SettingsPage；入口 bootstrap 只 hydrate 配置、
 *       不探测。若不在 /settings 触发探测，冷启动后 mode 可能停在 offline。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
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
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function waitJson(url, t) {
  const d = Date.now() + t;
  while (Date.now() < d) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

const CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen3.5:9b',
  maxTokens: 4096,
  disableThinking: true,
  allowRawData: false,
};

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-cold-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-proxy-server',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const out = {};
  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1) 首屏写入 localStorage（等价于「已保存配置」）
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(1500);
    await cdp.eval(`localStorage.setItem('hogo-qa-settings', ${JSON.stringify(JSON.stringify(CONFIG))})`);

    // 2) 冷启动直接进入 /ai（整页加载）
    await cdp.send('Page.navigate', { url: APP_URL + 'ai' });
    const deadline = Date.now() + 20000;
    let state = 'unknown';
    while (Date.now() < deadline) {
      state = await cdp.eval(
        "document.querySelector('[data-testid=\"ai-assistant-page\"]') ? 'ai-page' : (document.querySelector('[data-testid=\"ai-assistant-offline\"]') ? 'offline-gate' : 'loading')",
      );
      if (state !== 'loading') break;
      await sleep(300);
    }
    out.coldStartOnAi = state;
    out.modeReason = await cdp.eval(
      "(() => { const a=document.querySelector('[data-testid=\"ai-gate-disabled\"]'); return a? a.innerText : null; })()",
    );
    out.savedConfig = await cdp.eval("localStorage.getItem('hogo-qa-settings')");

    console.log(JSON.stringify(out, null, 2));
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }
}
main().catch((e) => {
  console.error('cold-start 探针失败:', e.stack || e);
  process.exit(1);
});
