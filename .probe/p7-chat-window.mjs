/**
 * p7-chat-window.mjs —— P7 真机真值：AI 助手「微信式」对话视窗。
 *
 * 为什么必须有这一层：jsdom 量不出布局，「固定视口 + 内部滚动 + 默认贴底」这件事
 * 在单测里只能靠假造的 scrollHeight/clientHeight 近似。真机看的是三个只有浏览器能回答的问题：
 *   1) 会话区是不是真的「内部滚动」（scrollHeight > clientHeight）？
 *   2) 整页有没有被内容撑长（用户看到的到底是微信式视窗，还是一条长列表）？
 *   3) 上拉读历史时，新消息会不会把人拽回底部（微信式交互的关键一条）？
 *
 * 用法：node .probe/p7-chat-window.mjs
 * 端口：应用 8807 / CDP 9487 / 桩 LLM 8977（与 p1~p6 探针错开）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/tools/Hogo-QA-tool';
const APP_PORT = 8807;
const CDP_PORT = 9487;
const LLM_PORT = 8977;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const OUT = ROOT + '/.probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 桩 LLM：回复刻意有多行，好让 14 轮问答一定超过一个视口高度。 */
const STUB_REPLY = [
  '结论：过程受控。',
  '· X-bar 图：无判异点，Cpk=1.42；',
  '· R 图：无链、无趋势；',
  '· 建议：维持当前参数，下一批抽检 30 件。',
].join('\n');

function startLlmStub() {
  const server = http.createServer((req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.url.includes('/models')) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ data: [{ id: 'stub-chat-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        model: 'stub-chat-model',
        choices: [{ finish_reason: 'stop', message: { content: STUB_REPLY } }],
      }));
    });
  });
  return new Promise((resolve) => server.listen(LLM_PORT, '127.0.0.1', () => resolve(server)));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

async function waitHttp(url, ms) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('timeout ' + url);
}

/** 页面侧的「真机几何」探针：距离底部的像素数 + 视窗是否内部滚动。 */
const BOX_EXPR = `(function(){
  var box = document.querySelector('[data-testid="ai-conversation-scroll"]');
  var main = document.querySelector('main');
  if (!box || !main) return null;
  return {
    gap: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight),
    scrollHeight: box.scrollHeight,
    clientHeight: box.clientHeight,
    scrollTop: Math.round(box.scrollTop),
    overflowY: getComputedStyle(box).overflowY,
    mainOverflow: Math.round(main.scrollHeight - main.clientHeight),
  };
})()`;

/** 往输入框里打字（React 受控输入：必须走原生 setter + input 事件）。 */
const TYPE_FN = `window.__type = function (value) {
  var el = document.querySelector('input[aria-label="数据问答输入"]');
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return !!el;
};`;

const SEND_FN = `window.__send = function (value) {
  window.__type(value);
  var btn = [].slice.call(document.querySelectorAll('button')).filter(function (b) {
    return b.textContent.trim() === '提问';
  })[0];
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
};`;

const COUNT_EXPR = `document.querySelectorAll('[data-testid^="ai-message-"]').length`;

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p7chat-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const report = { mode: 'p7-chat-window', asserts: [], ok: null, shots: [] };
  const check = (name, pass, detail) => {
    report.asserts.push({ name, pass: !!pass, detail });
  };

  const llm = await startLlmStub();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let preview;
  try {
    preview = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server',
      '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort',
    ], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const target = list.find((t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const waitEval = async (expr, label, timeout = 40000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        try { if (await cdp.eval(expr)) { report.steps = report.steps || []; return true; } } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('timeout ' + label);
    };
    const waitGapStable = async (label, timeout = 60000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        const a = await cdp.eval(COUNT_EXPR);
        await sleep(400);
        const b = await cdp.eval(COUNT_EXPR);
        if (a === b && a > 0) return a;
      }
      throw new Error('timeout ' + label);
    };

    // 1) 落 AI 配置 → 进 AI 助手页
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval('localStorage.setItem(\'hogo-qa-settings\', ' + JSON.stringify(JSON.stringify({
      baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1',
      apiKey: '',
      model: 'stub-chat-model',
      maxTokens: 2048,
      disableThinking: true,
    })) + ')');
    await cdp.send('Page.navigate', { url: APP_URL + 'ai' });
    await waitEval('!!document.querySelector(\'[data-testid="ai-assistant-page"]\')', 'AI 助手页', 30000);
    await sleep(1200);

    // 2) 剪贴板捕获（headless 读不到真剪贴板，改为拦截写入）
    await cdp.eval(`(function(){
      window.__copied = [];
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: function (t) { window.__copied.push(t); return Promise.resolve(); } },
        });
        return true;
      } catch (e) { window.__clipErr = String(e); return false; }
    })()`);
    await cdp.eval(TYPE_FN);
    await cdp.eval(SEND_FN);

    // 3) 默认态：面板收起 + 空会话
    check('默认只保留对话：工具面板收起', (await cdp.eval(
      'getComputedStyle(document.querySelector(\'[data-testid="ai-tools-panel"]\')).display',
    )) === 'none');
    check('空会话时不显示条数 chip', (await cdp.eval(
      '!document.querySelector(\'[data-testid="ai-conversation-count"]\')',
    )));
    await cdp.shot(path.join(OUT, 'p7-chat-empty.png'));
    report.shots.push('p7-chat-empty.png');

    // 4) 第一条消息用「回车」发（微信式：回车即发送）
    await cdp.eval(TYPE_FN + '; window.__type("第 1 个问题：这批数据受控吗？")');
    await cdp.eval(`(function(){
      var el = document.querySelector('input[aria-label="数据问答输入"]');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitEval(COUNT_EXPR + ' >= 2', '回车发送生效', 30000);
    check('回车即发送（不必点按钮）', true, 'entries>=2');

    // 5) 再发 12 条，凑够「超过一个视口」的内容
    for (let i = 2; i <= 13; i += 1) {
      await cdp.eval('window.__send("第 ' + i + ' 个问题：解释一下第 ' + i + ' 个子组的波动来源。")');
      await waitEval(COUNT_EXPR + ' >= ' + String(i * 2), '第 ' + i + ' 轮问答', 40000);
    }
    const entries = await waitGapStable('会话稳定');
    report.entries = entries;
    check('会话里是「我问 + AI 答」成对出现', entries === 26, 'entries=' + entries);

    let geo = await cdp.eval(BOX_EXPR);
    report.geometry = geo;
    check('会话区是「内部滚动」容器（内容高于视口）', geo.overflowY === 'auto' && geo.scrollHeight > geo.clientHeight + 100,
      'overflowY=' + geo.overflowY + ' scrollHeight=' + geo.scrollHeight + ' clientHeight=' + geo.clientHeight);
    check('整页没有被对话撑长（response 区无外滚）', geo.mainOverflow <= 2, 'main overflow=' + geo.mainOverflow);
    check('进入/新增消息后默认贴底', geo.gap <= 2, 'gap=' + geo.gap);
    await cdp.shot(path.join(OUT, 'p7-chat-bottom.png'));
    report.shots.push('p7-chat-bottom.png');

    // 6) 上拉读历史 → 新消息不许把人拽回底部
    await cdp.eval(`(function(){
      var box = document.querySelector('[data-testid="ai-conversation-scroll"]');
      box.scrollTop = 0;
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      return box.scrollTop;
    })()`);
    await cdp.eval('window.__send("上拉之后的新问题：还在吗？")');
    await waitEval(COUNT_EXPR + ' >= 28', '上拉后新增一轮', 40000);
    await sleep(800);
    geo = await cdp.eval(BOX_EXPR);
    check('上拉读历史时，新消息不会把视窗拽回底部', geo.scrollTop <= 2, 'scrollTop=' + geo.scrollTop + ' gap=' + geo.gap);
    await cdp.shot(path.join(OUT, 'p7-chat-scrolled-up.png'));
    report.shots.push('p7-chat-scrolled-up.png');

    // 7) 滚回底部 → 恢复跟随
    await cdp.eval(`(function(){
      var box = document.querySelector('[data-testid="ai-conversation-scroll"]');
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      return box.scrollTop;
    })()`);
    await cdp.eval('window.__send("滚回底部之后的新问题：跟上了吗？")');
    await waitEval(COUNT_EXPR + ' >= 30', '滚回底部后新增一轮', 40000);
    await sleep(800);
    geo = await cdp.eval(BOX_EXPR);
    check('滚回底部后恢复跟随（新消息自动贴底）', geo.gap <= 2, 'gap=' + geo.gap);

    // 8) 复制：每条消息都有按钮（含我提的问），且复制的是那一条的正文
    const userMsg = '第 1 个问题：这批数据受控吗？';
    const copyButtons = await cdp.eval('document.querySelectorAll(\'[data-testid^="ai-copy-entry-"]\').length');
    check('每条消息都有复制按钮（条数 = 消息条数）', copyButtons === 30, 'copyButtons=' + copyButtons);
    await cdp.eval('(function(){ var b=document.querySelector(\'[data-testid="ai-message-user"] [data-testid^="ai-copy-entry-"]\'); b.click(); return true; })()');
    await waitEval('window.__copied.length > 0', '复制用户消息', 10000);
    const copiedUser = await cdp.eval('window.__copied[window.__copied.length - 1]');
    check('用户提问可以复制（复制的就是那一条的正文）', copiedUser === userMsg, JSON.stringify(copiedUser).slice(0, 80));

    await cdp.eval('document.querySelector(\'[data-testid="ai-copy-transcript"]\').click()');
    await waitEval('window.__copied.length > 1', '复制整段对话', 10000);
    const copiedAll = await cdp.eval('window.__copied[window.__copied.length - 1]');
    report.transcriptLength = String(copiedAll).length;
    check('「复制对话」拼出整段会话（带「我 / AI 助手」前缀）',
      copiedAll.indexOf('我：' + userMsg) === 0 && copiedAll.indexOf('AI 助手：') > 0 && copiedAll.split('AI 助手：').length - 1 === 15,
      '长度=' + String(copiedAll).length + ' 分隔=' + String(copiedAll.split('AI 助手：').length - 1));

    // 9) 「+」面板展开后，快捷指令/数据主权/诊断入口都在
    await cdp.eval('document.querySelector(\'[data-testid="ai-toggle-tools"]\').click()');
    await sleep(400);
    check('点「+」后面板展开', (await cdp.eval(
      'getComputedStyle(document.querySelector(\'[data-testid="ai-tools-panel"]\')).display',
    )) === 'block');
    check('面板里能看到快捷指令与数据主权开关', await cdp.eval(
      '!!document.querySelector(\'[data-testid="ai-action-fullDiagnosis"]\') && !!document.querySelector(\'input[aria-label="允许发送原始数据"]\')',
    ));
    const panelGeo = await cdp.eval(`(function(){
      var input = document.querySelector('input[aria-label="数据问答输入"]');
      var r = input.getBoundingClientRect();
      var main = document.querySelector('main');
      return { bottom: Math.round(r.bottom), winH: window.innerHeight, mainOverflow: Math.round(main.scrollHeight - main.clientHeight) };
    })()`);
    report.panelGeo = panelGeo;
    check('展开面板后输入栏仍在视口内（没有被顶出屏幕）', panelGeo.bottom <= panelGeo.winH,
      '输入框底=' + panelGeo.bottom + ' 视口高=' + panelGeo.winH + ' 内容区溢出=' + panelGeo.mainOverflow);
    await cdp.shot(path.join(OUT, 'p7-chat-tools.png'));
    report.shots.push('p7-chat-tools.png');

    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
    try { llm.close(); } catch { /* */ }
  }

  fs.writeFileSync(path.join(OUT, 'p7-chat-window.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const a of report.asserts) console.log((a.pass ? 'PASS  ' : 'FAIL  ') + a.name + (a.detail ? '  [' + a.detail + ']' : ''));
  if (report.error) console.log('ERROR: ' + report.error);
  console.log('RESULT ok=' + report.ok + '  passed=' + report.asserts.filter((a) => a.pass).length + '/' + report.asserts.length);
}

main();