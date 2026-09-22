/**
 * p8-real-llm.mjs —— 真 LLM（DeepSeek 等 OpenAI 兼容服务）真机验收。
 *
 * 为什么要这一层：P8 的桩探针（p8-ai-context.mjs）证明「应用把子组序列 / 判异明细 /
 * 图表目录发出去了」，但**真模型**会不会照着这些数据回答、会不会还在说「摘要未提供」，
 * 只有打真 key 才能证伪。本探针不写任何 key 进仓库，只从环境变量读。
 *
 * 用法（PowerShell）：
 *   $env:DEEPSEEK_API_KEY = 'sk-你的key'
 *   node .probe/p8-real-llm.mjs
 *
 * 可选环境变量：
 *   DEEPSEEK_MODEL     默认 deepseek-chat（**不是** deepseek-flash；先看本探针第 1 步列出的真实模型名）
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com/v1
 *
 * 它按顺序做三件事：
 *   1) 列服务端**真实可用**的模型名（模型名写错 = 用户此前那条 HTTP 400 的头号原因）；
 *   2) 预检 chat/completions：分别用「关闭模型思考」开 / 关各打一次，把服务端原文打出来；
 *   3) 真机跑一遍应用：导入 → 侧栏进 AI 助手 → 提问「第几子组触发哪条判异规则」→
 *      断言回复点名了子组编号与判异规则、**没有**「摘要未提供 / 数据不足」这类话，
 *      并在模型引用图表时确认真的画出了图（不是空 div）。
 *
 * 退出码：0 = 全绿；1 = 有断言红；2 = 没配 key（跳过，不算失败）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CHROME } from './_env.mjs';
const ROOT = process.env.HOGO_ROOT || path.resolve(import.meta.dirname, '..');
const OUT = ROOT + '/.probe';
const APP_PORT = 8817;
const CDP_PORT = 9497;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = (process.env.DEEPSEEK_API_KEY || process.env.HOGO_LLM_KEY || '').trim();
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();

/** 用户报障里那句「未提供」类回答的指纹（出现即视为回归）。 */
const DODGE_PATTERNS = [
  '摘要未提供', '未提供相关', '数据不足', '未给出控制图', '无法判断',
  '不能编造', '未包含子组', '没有提供',
];

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
  for (var i = 0; i < d.length; i += 4) {
    if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink += 1;
  }
  return ink / (w * h);
})()`;

/** 第 1 步：列服务端真实模型名。 */
async function listModels(report) {
  try {
    const r = await fetch(BASE + '/models', { headers: { Authorization: 'Bearer ' + KEY } });
    const text = await r.text();
    report.models = { status: r.status, body: text.slice(0, 1200) };
    let ids = [];
    try {
      const j = JSON.parse(text);
      ids = (j.data || []).map((m) => m.id).filter(Boolean);
    } catch { /* 非 JSON：原文已在 report 里 */ }
    report.modelIds = ids;
    return ids;
  } catch (e) {
    report.models = { error: String((e && e.message) || e) };
    return [];
  }
}

/** 第 2 步：预检一次最小 chat/completions，返回 {status, bodyHead, ok}。 */
async function preflight(disableThinking) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是测试助手，只回一个词。' },
      { role: 'user', content: '回答：ok' },
    ],
    max_tokens: 32,
    temperature: 0,
  };
  if (disableThinking) {
    // 与「设置」页「关闭模型思考」同一口径（见 services/ai/client 的请求构造）。
    body.reasoning_effort = 'none';
  }
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { disableThinking, status: r.status, ok: r.ok, bodyHead: text.slice(0, 600) };
  } catch (e) {
    return { disableThinking, status: 0, ok: false, bodyHead: '网络错误：' + String((e && e.message) || e) };
  }
}

async function main() {
  const report = { mode: 'p8-real-llm', model: MODEL, base: BASE, asserts: [], ok: null };

  if (KEY.length === 0) {
    console.log('SKIP  没有配 key：本探针只从环境变量读，不碰仓库。');
    console.log('      PowerShell:  $env:DEEPSEEK_API_KEY = \'sk-你的key\'; node .probe/p8-real-llm.mjs');
    console.log('      可选：       $env:DEEPSEEK_MODEL = \'deepseek-chat\'');
    process.exit(2);
  }

  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });

  // ---- 1) 真实模型名 ----
  const ids = await listModels(report);
  console.log('— 服务端可用模型：' + (ids.length > 0 ? ids.join(', ') : '（未能列出，见 .probe/p8-real-llm.json 里的原文）'));
  if (report.models && report.models.status && !ids.length) {
    console.log('  服务端返回 HTTP ' + report.models.status + '：' + String(report.models.body || '').slice(0, 200));
  }
  if (ids.length > 0) {
    check('设置里的模型名在服务端真实存在', ids.includes(MODEL), 'model=' + MODEL + ' 可用=' + ids.join('/'));
    if (!ids.includes(MODEL)) {
      console.log('  ✗ 模型名「' + MODEL + '」不在服务端清单里 —— 这正是 HTTP 400 的头号原因；');
      console.log('    请把「设置」页的模型名改成上面清单里的一个（DeepSeek 官方通常是 deepseek-chat / deepseek-reasoner）。');
    }
  }

  // ---- 2) 预检（思考开关两种口径） ----
  const pre1 = await preflight(true);
  report.preflight = [pre1];
  if (!pre1.ok) {
    report.preflight.push(await preflight(false));
  }
  const usable = report.preflight.find((p) => p.ok) || null;
  console.log('— 预检：' + report.preflight.map((p) =>
    '关闭思考=' + p.disableThinking + '→HTTP ' + p.status + (p.ok ? ' OK' : ' ' + p.bodyHead.slice(0, 160)),
  ).join(' | '));
  check('真 key 能打通 chat/completions', usable !== null,
    usable ? ('关闭思考=' + usable.disableThinking) : (report.preflight[0].bodyHead || '').slice(0, 200));
  const disableThinking = usable ? usable.disableThinking : true;
  if (report.preflight.length === 2 && !report.preflight[0].ok && report.preflight[1].ok) {
    console.log('  ! 带 reasoning_effort 的那次被拒了 → 真机运行改用「关闭模型思考」= 关。');
  }

  // ---- 3) 真机跑一遍应用 ----
  const profile = path.join(os.tmpdir(), 'hogo-p8real-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--window-size=1500,1100', 'about:blank',
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

    const waitEval = async (expr, label, timeout = 60000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        try { if (await cdp.eval(expr)) return true; } catch { /* retry */ }
        await sleep(250);
      }
      throw new Error('timeout ' + label);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval(`localStorage.setItem('hogo-qa-settings', ${JSON.stringify(JSON.stringify({
      baseUrl: BASE,
      apiKey: KEY,
      model: MODEL,
      maxTokens: 4096,
      disableThinking,
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

    // 必须走侧栏（客户端路由）：整页跳转会清空内存里的 dataset。
    await cdp.eval(`(function(){
      var a = document.querySelector('[data-testid="app-sidebar"] a[href="/ai"]');
      a.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="ai-assistant-page"]\')', 'AI 助手页', 30000);
    await sleep(800);

    await cdp.eval(`(function(){
      var el = document.querySelector('input[aria-label="数据问答输入"]');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '这批数据里第几子组触发了哪条判异规则？请点名特性与子组编号。');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      var btn = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent.trim() === '提问'; })[0];
      btn.click(); return true;
    })()`);
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 2', 'AI 回复到达', 120000);
    await sleep(3000);

    const reply = await cdp.eval(`(function(){
      var msg = [].slice.call(document.querySelectorAll('[data-testid="ai-message-assistant"]')).pop();
      return msg ? msg.innerText : '';
    })()`);
    report.reply = reply;

    check('真模型真的回了内容', typeof reply === 'string' && reply.trim().length > 20, 'len=' + (reply || '').length);
    const httpErr = /HTTP\s*\d{3}/.exec(reply || '');
    check('没有 HTTP 报错气泡', httpErr === null, httpErr ? httpErr[0] : '');
    check('回复点名了具体子组编号（第 7 个子组 / 子组 7）',
      /第\s*7\s*个子组|子组\s*7|subgroup\s*7/i.test(reply || ''));
    check('回复给出了判异规则编号（W1…W4 / N1…N8）',
      /W[1-4]|N[1-8]/.test(reply || ''));
    const dodged = DODGE_PATTERNS.filter((p) => (reply || '').includes(p));
    check('没有再出现「摘要未提供 / 数据不足」这类推诿话术', dodged.length === 0, dodged.join('、'));

    // 图表引用：模型给了标记就必须画出真图；没给不算错（由提示词引导，不强制）。
    const hasChartArea = await cdp.eval('!!document.querySelector(\'[data-testid="ai-chart-refs"]\')');
    const ink = await cdp.eval(INK_EXPR);
    report.hasChartArea = hasChartArea; report.chartInk = ink;
    check('模型引用图表时真的画出了图（没有引用则跳过）', !hasChartArea || (typeof ink === 'number' && ink > 0.01),
      'hasArea=' + hasChartArea + ' ink=' + ink);
    check('正文里不露出 [[chart:…]] 标记', (reply || '').indexOf('[[chart:') < 0);

    await cdp.shot(path.join(OUT, 'p8-real-llm.png'));

    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
  }

  fs.writeFileSync(path.join(OUT, 'p8-real-llm.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const a of report.asserts) console.log((a.pass ? 'PASS  ' : 'FAIL  ') + a.name + (a.detail ? '  [' + a.detail + ']' : ''));
  if (report.error) console.log('ERROR: ' + report.error);
  console.log('RESULT ok=' + report.ok + '  passed=' + report.asserts.filter((a) => a.pass).length + '/' + report.asserts.length);
  process.exit(report.ok ? 0 : 1);
}

main();