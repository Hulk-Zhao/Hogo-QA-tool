/**
 * p8-ai-context.mjs —— P8 真机真值：发出去的「数据面」+ AI 引用的图表。
 *
 * 为什么必须有这一层：用户报障是**真机里读到的**那句话
 * （「这份统计摘要里…未给出控制图点子序列，warnings 全为空，因此不能编造第几子组触发某判异规则」）。
 * 单测只能证明「我们构造的上下文里有 points/violations」，
 * 真机才能回答另外三件事：
 *   1) 请求**真的**带着子组序列 / 判异明细 / 图表目录出门了吗（抓真实请求体）？
 *   2) 提示词里的「数据契约」真的随请求发出去了吗？
 *   3) AI 回复里引用的 [[chart:...]] 有没有被渲染成**真图**（不是空 div）？
 *
 * 用法：node .probe/p8-ai-context.mjs [offline]
 * 端口：应用 8813（offline 8815）/ CDP 9493（offline 9495）/ 桩 LLM 8983（offline 8985）。
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
const APP_PORT = OFFLINE ? 8815 : 8813;
const CDP_PORT = OFFLINE ? 9495 : 9493;
const LLM_PORT = OFFLINE ? 8985 : 8983;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 桩 LLM 的回复：刻意带一个图表引用标记 + 一句「落到底」的结论。 */
const CHART_ID = 'chart:control:外壳长度';
const STUB_REPLY = [
  '结论：**外壳长度第 7 个子组**均值超出上控制限（UCL），属 1 点超出 ±3σ 的判异。',
  '',
  '- 依据：points[6].mean 明显高于 CL，violations 命中 W1，其 subgroupIndices 为 [7]；',
  '- 其余特性无判异，能力仍在合格线以上。',
  '',
  `[[${CHART_ID}]]`,
  '',
  '建议：停线复测第 7 子组，连续 5 个子组均值仍 > UCL 则校准刀具。',
].join('\n');

function startLlmStub() {
  const captured = [];
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
      res.end(JSON.stringify({ data: [{ id: 'stub-p8-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push(body);
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        model: 'stub-p8-model',
        choices: [{ finish_reason: 'stop', message: { content: STUB_REPLY } }],
      }));
    });
  });
  return new Promise((resolve) => server.listen(LLM_PORT, '127.0.0.1', () => resolve({ server, captured })));
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

/** 造一份 CSV：外壳长度第 7 子组整体抬高（越 UCL），转轴直径正常。 */
function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let g = 0; g < 12; g += 1) {
    for (let k = 0; k < 5; k += 1) {
      const base = 50 + Math.sin(g * 5 + k) * 0.02;
      const shifted = g === 6 ? base + 0.6 : base;
      rows.push('外壳长度,' + shifted.toFixed(4) + ',50.2,49.8');
    }
  }
  for (let i = 0; i < 60; i += 1) {
    rows.push('转轴直径,' + (12 + Math.sin(i * 0.9) * 0.005).toFixed(4) + ',12.02,11.98');
  }
  return rows.join('\n');
}

/** 画布墨迹占比：证明「真的画出来了」而不是空 div。 */
const INK_EXPR = `(function(){
  var canvas = document.querySelector('[data-testid="ai-chart-refs"] [data-testid="control-chart"] canvas');
  if (!canvas) return -1;
  var w = 160, h = 100;
  var off = document.createElement('canvas'); off.width = w; off.height = h;
  var ctx = off.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  try { ctx.drawImage(canvas, 0, 0, w, h); } catch (e) { return -2; }
  var d = ctx.getImageData(0, 0, w, h).data;
  var ink = 0;
  for (var i = 0; i < d.length; i += 4) { if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) ink += 1; }
  return Math.round(ink / (w * h) * 10000) / 10000;
})()`;

async function main() {
  const report = { mode: OFFLINE ? 'p8-ai-context-offline' : 'p8-ai-context', asserts: [], ok: null };
  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });

  const { server: llm, captured } = await startLlmStub();
  const profile = path.join(os.tmpdir(), (OFFLINE ? 'hogo-p8off-' : 'hogo-p8-') + Date.now());
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

    // 1) AI 配置 → 导入数据（粘贴 CSV）
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval(`localStorage.setItem('hogo-qa-settings', ${JSON.stringify(JSON.stringify({
      baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1',
      apiKey: '',
      model: 'stub-p8-model',
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

    // 2) 进 AI 助手页并发问（就用用户报障时那种问法）
    // 关键：必须走侧栏链接（客户端路由），不能整页跳转 ——
    // 整页跳转会重建 JS 运行时，内存里的 dataset 被清空（项目仅在手点「保存项目」后才落盘），
    // AI 页就会退化成「当前项目暂无数据」，探针测到的将是空上下文（P8 首跑即栽在这里）。
    await cdp.eval(`(function(){
      var a = document.querySelector('[data-testid="app-sidebar"] a[href="/ai"]');
      if (!a) { throw new Error('侧栏没有 AI 助手入口'); }
      a.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="ai-assistant-page"]\')', 'AI 助手页', 30000);
    await sleep(1000);
    // 前置断言：AI 页必须看到数据（红框根因的前置条件），否则后面测的都不是用户场景。
    // 只断言「不是空项目空态」：特性名此时还没进 DOM（要等 AI 出图后标题里才有），
    // 用 innerText 搜特性名会在这一步假红（首跑即踩过）。
    const emptyState = await cdp.eval('document.body.innerText.indexOf("当前项目暂无数据") >= 0');
    check('AI 页拿到了导入的数据（不是「暂无数据」空态）', !emptyState);
    await cdp.eval(`(function(){
      var el = document.querySelector('input[aria-label="数据问答输入"]');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '这批数据里第几子组触发了哪条判异规则？请点名特性与子组编号。');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      var btn = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent.trim() === '提问'; })[0];
      btn.click(); return true;
    })()`);
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 2', 'AI 回复到达', 40000);
    await sleep(2500);

    // 3) 抓真实请求体：数据面 + 提示词
    check('桩 LLM 真的收到了请求', captured.length >= 1, 'requests=' + captured.length);
    const raw = captured[captured.length - 1] ?? '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* 留空 */ }
    const messages = parsed.messages ?? [];
    const systemPrompt = String((messages.find((m) => m.role === 'system') ?? {}).content ?? '');
    const userBody = String((messages.find((m) => m.role === 'user') ?? {}).content ?? '');
    report.requestBytes = raw.length;

    check('请求体带上了逐子组均值序列（points + subgroupCount）',
      userBody.includes('"points"') && userBody.includes('"subgroupCount"'));
    check('请求体带上了判异明细与 1-based 子组编号（violations + subgroupIndices）',
      userBody.includes('"violations"') && userBody.includes('"subgroupIndices"'));
    check('请求体带上了控制限与图型（ucl / lcl / chartType）',
      userBody.includes('"ucl"') && userBody.includes('"lcl"') && userBody.includes('"chartType"'));
    check('请求体带上了图表目录与规则清单（chartCatalogue / ruleSet）',
      userBody.includes('"chartCatalogue"') && userBody.includes('"ruleSet"') && userBody.includes(CHART_ID));
    check('提示词含数据契约：禁止「摘要未提供」，并要求引用真实图表',
      systemPrompt.includes('严禁臆造') && /禁[止止][^。]{0,20}摘要未提供/.test(systemPrompt) && systemPrompt.includes('[[chart:'));
    check('数据主权未放宽：请求体里没有逐条原始测量值',
      !userBody.includes('__raw') && !raw.includes('"measurements"'), 'bytes=' + raw.length);

    // 4) 越限子组确实被算出来了（第 7 子组）
    const violationHit = /"subgroupIndices":\s*\[\s*7\s*\]/.test(userBody);
    const outOfLimitHit = /"subgroupIndex":\s*7/.test(userBody);
    check('第 7 子组越限被明确写出（violations.subgroupIndices / outOfLimit.subgroupIndex）',
      violationHit || outOfLimitHit, 'violations=' + violationHit + ' outOfLimit=' + outOfLimitHit);

    // 5) 回复里的图表引用被渲染成**真图**
    check('AI 回复里渲染出图表区（ai-chart-refs）',
      await cdp.eval('!!document.querySelector(\'[data-testid="ai-chart-refs"]\')'));
    check('渲染的是控制图组件（control-chart）',
      await cdp.eval('!!document.querySelector(\'[data-testid="ai-chart-refs"] [data-testid="control-chart"] canvas\')'));
    const ink = await cdp.eval(INK_EXPR);
    report.chartInk = ink;
    check('图表真的画出了墨迹（不是空画布）', typeof ink === 'number' && ink > 0.01, 'ink=' + ink);
    const bubbleText = await cdp.eval(`(function(){
      var msg = [].slice.call(document.querySelectorAll('[data-testid="ai-message-assistant"]')).pop();
      return msg ? msg.innerText : '';
    })()`);
    check('正文里不露出 [[chart:…]] 标记', bubbleText.indexOf('[[chart:') < 0);
    check('正文里能看到模型点名了第 7 子组', bubbleText.indexOf('第 7 个子组') >= 0);
    check('气泡上的「发送字段」清单列出了新增数据面',
      bubbleText.indexOf('chartCatalogue') >= 0 || bubbleText.indexOf('subgroupConfig') >= 0);

    await cdp.shot(path.join(OUT, OFFLINE ? 'p8-chat-offline.png' : 'p8-chat.png'));

    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
    try { llm.close(); } catch { /* */ }
  }

  const file = OFFLINE ? 'p8-ai-context-offline.json' : 'p8-ai-context.json';
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(report, null, 2), 'utf8');
  for (const a of report.asserts) console.log((a.pass ? 'PASS  ' : 'FAIL  ') + a.name + (a.detail ? '  [' + a.detail + ']' : ''));
  if (report.error) console.log('ERROR: ' + report.error);
  console.log('RESULT ok=' + report.ok + '  passed=' + report.asserts.filter((a) => a.pass).length + '/' + report.asserts.length);
}

main();