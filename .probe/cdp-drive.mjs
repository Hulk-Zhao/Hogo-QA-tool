/**
 * 真实 Chrome 端到端驱动（零依赖，用 Node 22 内建 WebSocket 走 CDP）。
 * 目的：证明「构建产物里的客户端」真的会把 reasoning_effort / max_tokens 发出去，
 * 并且能把返回正文渲染到页面上 —— 这是本项目反复出现的「接线类缺陷」的最终验证手段。
 *
 * 用本地模拟服务端（8899），不占用 Ollama。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9223;
const PROFILE = 'E:/tools/Hogo-QA-tool/.probe/chrome-profile';
const CAPTURED = 'E:/tools/Hogo-QA-tool/.probe/captured-requests.jsonl';
const OUT = 'E:/tools/Hogo-QA-tool/.probe/e2e-result.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res) => {
            const id = ++seq;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      }),
      ws.onerror = (e) => reject(new Error('WS error: ' + (e?.message ?? 'unknown')));
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error('PAGE EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  }
  return r.result?.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await evaluate(cdp, expression);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('TIMEOUT waiting: ' + label);
    await sleep(400);
  }
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
try {
  // 等 CDP 端点起来
  let target = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(500);
  }
  if (!target) throw new Error('no CDP target');

  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: APP_URL + '#/ai' });

  // 等应用挂载（首次加载时配置为空，会先落在离线闸门 —— 这是正确行为，只要求 #root 有内容）
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 25000, 'app mount');

  // 写入配置（baseUrl 指向本地模拟服务端；Key 留空 —— 验证「无 Key 本地服务可启用」这条修复）
  await evaluate(cdp, `(() => {
    localStorage.setItem('hogo-qa-settings', JSON.stringify({
      baseUrl: 'http://127.0.0.1:8899/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      allowRawData: false,
      maxTokens: 29019,
      disableThinking: true,
    }));
    return 'config-set';
  })()`);
  await evaluate(cdp, `location.reload(); 'reloading'`);
  await sleep(2500);
  await waitFor(cdp, `!!document.querySelector('[data-testid="ai-assistant-page"]')`, 25000, 'app remount in AI mode');

  const modeInfo = await evaluate(cdp, `(() => {
    const t = document.body.innerText;
    return { hasAiMode: t.includes('AI 模式'), hasOffline: t.includes('离线模式') };
  })()`);

  // 填入问题并点击「提问」（qa 入口不依赖 dataset，无需先导数据）
  const typed = await evaluate(cdp, `(() => {
    const el = document.querySelector('input[aria-label="数据问答输入"]');
    if (!el) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '当前哪个特性能力最差？');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  const clicked = await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '提问');
    if (!btn) return 'NO_BUTTON';
    if (btn.disabled) return 'BUTTON_DISABLED';
    btn.click();
    return 'clicked';
  })()`);

  // 等正文渲染出来
  const convo = await waitFor(
    cdp,
    `(() => {
      const box = document.querySelector('[data-testid="ai-conversation"]');
      if (!box) return null;
      const t = box.innerText || '';
      return t.includes('MOCK-OK') ? t.slice(0, 600) : null;
    })()`,
    25000,
    'assistant reply',
  );

  const result = {
    ok: true,
    modeInfo,
    typed,
    clicked,
    assistantReply: convo,
    capturedRequests: fs.existsSync(CAPTURED)
      ? fs.readFileSync(CAPTURED, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [],
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, modeInfo, typed, clicked, captured: result.capturedRequests.length }, null, 2));
} catch (e) {
  fs.writeFileSync(
    OUT,
    JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 2),
  );
  console.log('E2E FAILED: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
}
