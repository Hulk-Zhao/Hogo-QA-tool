/**
 * p9-ai-stream.mjs —— P9 真机真值：断流归因 + 自动重试。
 *
 * 用户报障截图（2026-09-20）：连着两次「AI 返回内容读取失败（响应流中断）」，第三次手点才成功。
 * 单测只能证明「构造的异常路径文案对不对」，真机才能回答三件事：
 *   1) 桩**真的把响应截断**时，浏览器这一侧拿到的确实是「读到一半失败」；
 *   2) 应用**真的自己重试了一次**（而不是又让用户手点）；
 *   3) 用户读到的文案里，有没有「已自动重试 1 次」「已收到 N 字节」这些能自助排查的信息。
 *
 * 用法：node .probe/p9-ai-stream.mjs [offline]
 * 端口：应用 8819（offline 8821）/ CDP 9499（offline 9501）/ 桩 LLM 8987（offline 8989）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const OUT = ROOT + '/.probe';
const OFFLINE = (process.argv[2] || '') === 'offline';
const OUT_DIR = OFFLINE ? 'dist' : 'dist-server';
const APP_PORT = OFFLINE ? 8821 : 8819;
const CDP_PORT = OFFLINE ? 9501 : 9499;
const LLM_PORT = OFFLINE ? 8989 : 8987;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 第二次（重试后）成功时返回的正文 —— 明确写清「这是重试之后」。 */
/** 第 3 题（慢回答）用的正文。 */
const SLOW_REPLY = '结论：慢是慢了点，但确实答上了。\n\n- 本次等待超过 3 秒，用于验证「已等待 N 秒」与「停止」按钮。';

/** 第二次（重试后）成功时返回的正文 —— 明确写清「这是重试之后」。 */
const RETRY_OK_REPLY = '结论：**外壳长度**过程受控（重试后成功拿到正文）。\n\n- Xbar-R 图无判异点，能力指数 Cpk=1.33 达标。';

/**
 * 桩 LLM：第 1、3、4 次请求**把响应写到一半就掐断连接**，第 2 次正常返回。
 *
 * 「写到一半再掐」是关键：Content-Length 说明有 99999 字节，实际只发几十字节就 destroy，
 * 浏览器侧必然报「读正文失败」并**已经收到若干字节** —— 这正是区分
 * 「连接被切断（0 字节）」与「长响应被网关截断（N 字节）」的那条证据链。
 */
function startLlmStub() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url.includes('/models')) {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ data: [{ id: 'stub-p9-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(body);
      const n = hits.length;
      const okReply = (text) => {
        res.writeHead(200, cors);
        res.end(JSON.stringify({ model: 'stub-p9-model', choices: [{ finish_reason: 'stop', message: { content: text } }] }));
      };
      // 第 2 次（= 第 1 题的自动重试）正常返回；3、4 次继续截断；
      // 第 5 次「慢回答」（3.5s）；第 6 次一直卡住（给「停止」按钮用）。
      if (n === 2) { okReply(RETRY_OK_REPLY); return; }
      if (n === 5) { setTimeout(() => okReply(SLOW_REPLY), 3500); return; }
      if (n === 6) { return; }
      res.writeHead(200, { ...cors, 'Content-Length': '99999' });
      res.write(JSON.stringify({ model: 'stub-p9-model', choices: [{ message: { content: '写到一半' } }] }).slice(0, 40));
      setTimeout(() => { try { req.socket.destroy(); } catch { /* */ } }, 20);
    });
  });
  return new Promise((resolve) => server.listen(LLM_PORT, '127.0.0.1', () => resolve({ server, hits })));
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

/** 造一份 CSV：外壳长度 12 个子组（第 7 子组抬高），转轴直径正常。 */
function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let g = 0; g < 12; g += 1) {
    for (let k = 0; k < 5; k += 1) {
      const base = 50 + Math.sin(g * 5 + k) * 0.02;
      rows.push('外壳长度,' + (g === 6 ? base + 0.6 : base).toFixed(4) + ',50.2,49.8');
    }
  }
  for (let i = 0; i < 60; i += 1) {
    rows.push('转轴直径,' + (12 + Math.sin(i * 0.9) * 0.005).toFixed(4) + ',12.02,11.98');
  }
  return rows.join('\n');
}

const BUBBLES_EXPR = `(function(){
  return [].slice.call(document.querySelectorAll('[data-testid="ai-message-assistant"]')).map(function(m){ return m.innerText; });
})()`;

async function main() {
  const report = { mode: OFFLINE ? 'p9-ai-stream-offline' : 'p9-ai-stream', asserts: [], ok: null };
  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });

  const { server: llm, hits } = await startLlmStub();
  const profile = path.join(os.tmpdir(), (OFFLINE ? 'hogo-p9off-' : 'hogo-p9-') + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let preview;
  try {
    preview = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', 'preview', '--outDir', OUT_DIR,
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
        try { if (await cdp.eval(expr)) return true; } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('timeout ' + label);
    };
    const ask = async (text) => {
      await cdp.eval(`(function(){
        var el = document.querySelector('input[aria-label="数据问答输入"]');
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await cdp.eval(`(function(){
        var btn = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent.trim() === '提问'; })[0];
        btn.click(); return true;
      })()`);
    };

    // 1) 配置 + 导入数据（整页跳转换页 OK：此时还没数据依赖）
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval(`localStorage.setItem('hogo-qa-settings', ${JSON.stringify(JSON.stringify({
      baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1',
      apiKey: '',
      model: 'stub-p9-model',
      maxTokens: 4096,
      disableThinking: true,
    }))})`);
    await cdp.send('Page.navigate', { url: APP_URL + 'import' });
    await waitEval('!!document.querySelector(\'[data-testid="import-page"]\')', '导入页', 30000);
    await cdp.eval(`(function(){
      var tab = [].slice.call(document.querySelectorAll('.MuiTab-root')).filter(function (e) { return e.textContent.indexOf('粘贴 CSV') >= 0; })[0];
      tab.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'textarea[data-testid="paste-input"]\')', '粘贴框');
    await cdp.eval(`(function(){
      var el = document.querySelector('textarea[data-testid="paste-input"]');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(buildCsv())});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await cdp.eval(`(function(){
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (e) { return e.textContent.trim() === '解析'; })[0];
      b.click(); return true;
    })()`);
    await waitEval(`(function(){
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (e) { return e.textContent.trim() === '确认导入并分析'; })[0];
      return !!b && !b.disabled;
    })()`, '解析完成', 30000);
    await cdp.eval(`(function(){
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (e) { return e.textContent.trim() === '确认导入并分析'; })[0];
      b.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="capability-page"]\')', '能力页', 30000);

    // 2) 侧栏进 AI 助手（客户端路由，别整页跳转丢 dataset）
    await cdp.eval(`(function(){
      var a = document.querySelector('[data-testid="app-sidebar"] a[href="/ai"]');
      a.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="ai-assistant-page"]\')', 'AI 助手页', 30000);
    await sleep(800);

    // 3) 第 1 题：桩第 1 次截断、第 2 次正常 → 应用应当自己重试并成功
    await ask('这批数据受控吗？（第 1 题）');
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 2', '第 1 题回复', 60000);
    await sleep(1200);
    const afterQ1 = hits.length;
    check('第 1 题：应用自己重试了（桩收到 2 次请求，用户没手点）', afterQ1 === 2, 'hits=' + afterQ1);
    let bubbles = await cdp.eval(BUBBLES_EXPR);
    const b1 = bubbles[bubbles.length - 1] || '';
    report.firstBubble = b1;
    check('第 1 题：重试后真的拿到了正文（没有把失败甩给用户）', b1.includes('重试后成功拿到正文'), 'len=' + b1.length);
    check('第 1 题：气泡里不再出现「响应流中断」这句无用文案', !b1.includes('响应流中断'));

    // 4) 第 2 题：桩连续两次都截断 → 文案必须能自助排查
    await ask('再问一次：过程稳定吗？（第 2 题）');
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-\"]\').length >= 4', '第 2 题回复', 60000);
    await sleep(1200);
    const afterQ2 = hits.length;
    check('第 2 题：两次截断 → 应用也只重试一次（共 2 次请求，不无限重试）', afterQ2 === 4, 'hits=' + afterQ2);
    bubbles = await cdp.eval(BUBBLES_EXPR);
    const b2 = bubbles[bubbles.length - 1] || '';
    report.secondBubble = b2;
    check('第 2 题：文案说明「已自动重试 1 次」', b2.includes('已自动重试 1 次'));
    check('第 2 题：文案说明是「传到一半被切断」并给出已收字节数', b2.includes('传到一半被切断') && /已收到 \d+ 字节/.test(b2));
    check('第 2 题：给了可操作建议（VPN / 代理 / 再问一次）', b2.includes('VPN') && b2.includes('再问一次'));
    check('第 2 题：不再出现「响应流中断」这句无用文案', !b2.includes('响应流中断'));

    // 5) 第 3 题：桩慢 3.5 秒才回 → 等待期间必须能看出「在动」且能停
    await ask('第 3 题：慢回答也要看得出来在动');
    await waitEval('!!document.querySelector(\'[data-testid="ai-thinking"]\')', '出现等待提示', 15000);
    let waitText = '';
    for (let i = 0; i < 40; i += 1) {
      waitText = await cdp.eval('(function(){var e=document.querySelector(\'[data-testid="ai-thinking"]\');return e?e.innerText:"";})()');
      if (/已等待 [1-9]\d* 秒/.test(waitText)) { break; }
      await sleep(250);
    }
    check('第 3 题：等待期间显示「已等待 N 秒」（慢请求不再像卡死）', /已等待 [1-9]\d* 秒/.test(waitText), waitText.trim());
    check('第 3 题：等待期间有「停止」按钮', await cdp.eval('!!document.querySelector(\'[data-testid="ai-stop"]\')'));
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 6', '第 3 题回复', 60000);
    await sleep(600);

    // 6) 第 4 题：桩一直不回答 → 点「停止」必须真的中断（超时放宽到 120s 后的关键兜底）
    await ask('第 4 题：卡住的请求要能停掉');
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 7', '第 4 题已发出', 20000);
    await sleep(1500);
    await cdp.eval('(function(){document.querySelector(\'[data-testid="ai-stop"]\').click();return true;})()');
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 8', '第 4 题取消后的气泡', 30000);
    await sleep(500);
    const b4 = (await cdp.eval(BUBBLES_EXPR)).pop() || '';
    report.cancelBubble = b4;
    check('第 4 题：点「停止」后气泡显示「请求已取消。」', b4.includes('请求已取消'));
    check('第 4 题：取消属于用户意图 → 不自动重试（桩仍只收到 6 次请求）', hits.length === 6, 'hits=' + hits.length);

    check('四题都留下了对话记录（共 8 条消息）',
      (await cdp.eval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length')) >= 8);

    await cdp.shot(path.join(OUT, OFFLINE ? 'p9-stream-offline.png' : 'p9-stream.png'));

    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
    try { llm.close(); } catch { /* */ }
  }

  const file = OFFLINE ? 'p9-ai-stream-offline.json' : 'p9-ai-stream.json';
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(report, null, 2), 'utf8');
  for (const a of report.asserts) console.log((a.pass ? 'PASS  ' : 'FAIL  ') + a.name + (a.detail ? '  [' + a.detail + ']' : ''));
  if (report.error) console.log('ERROR: ' + report.error);
  console.log('RESULT ok=' + report.ok + '  passed=' + report.asserts.filter((a) => a.pass).length + '/' + report.asserts.length);
}

main();