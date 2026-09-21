/**
 * p9-real-llm.mjs —— P9 真 LLM 真机验收（你自跑的那条命令）。
 *
 * 与 p8-real-llm.mjs 的区别：这一版按用户原话「需要你**全面诊断**」把
 * 「AI 全面诊断（一键）」也纳入真机断言（五节结构必须齐全），
 * 并把「没配 key 时怎么办」说清楚（支持环境变量或 `.secrets/deepseek.key` 文件）。
 *
 * 用法（PowerShell，二选一）：
 *   $env:DEEPSEEK_API_KEY = 'sk-你的key'; node .probe/p9-real-llm.mjs
 *   或者把 key 单独写进 E:\tools\Hogo-QA-tool\.secrets\deepseek.key（该目录已在 .gitignore 中）
 *   再不济会自动回退读 Windows 用户变量（注册表 HKCU\Environment）——为了区分
 *   「对话框里没点确定 = 没保存」与「保存了但当前终端没继承」这两种情况。
 *
 * 可选环境变量：
 *   DEEPSEEK_MODEL     默认 deepseek-chat（**不是** deepseek-flash；第 1 步会列出服务端真实模型名）
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com/v1
 *
 * 三步：
 *   1) 列服务端真实可用模型名（模型名写错 = 400 的头号原因）；
 *   2) 预检 chat/completions（「关闭模型思考」开/关各打一次，把服务端原文打出来）；
 *   3) 真机跑应用：数据导入 → 侧栏进 AI 助手 → ① 数据问答（必须点名子组编号与判异规则 id、
 *      不许回「摘要未提供」）→ ② 一键全面诊断（五节标题齐全、不许回「摘要未提供」）。
 *
 * 退出码：0 全绿 / 1 有红 / 2 没配 key（跳过，不算失败）。
 *
 * 注意：本探针刻意用 `--no-proxy-server` 直连（你机器的系统代理是 iKuuuVPN 127.0.0.1:7890）。
 * 这样探针结果是**确定**的：探针绿而你的界面仍报「连接被切断」，就指向 VPN / 代理这一层。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/tools/Hogo-QA-tool';
const OUT = ROOT + '/.probe';
const APP_PORT = 8823;
const CDP_PORT = 9503;
const APP_URL = 'http://127.0.0.1:' + APP_PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用户报障里那句「未提供」类回答的指纹（出现即视为回归）。 */
const DODGE_PATTERNS = [
  '摘要未提供', '未提供相关', '数据不足', '未给出控制图', '无法判断',
  '不能编造', '未包含子组', '没有提供',
];
/** 全面诊断必须齐全的五节。 */
const SECTIONS = ['总体结论', '过程能力盘点', '主要问题与疑似根因', '改善行动', '数据局限与风险提示'];

/**
 * 读 Windows「用户变量」里持久化的环境变量（注册表 `HKCU\Environment`）。
 *
 * 为什么要直连注册表：变量加进 Windows 对话框后，**已经开着的**终端 / 应用（含本探针的父进程）
 * 不会继承新变量 —— 只读 `process.env` 会把「我明明加了」错判成「你没配」。
 * 读注册表就能把两件事分开：
 *   ① 变量**根本没保存**（对话框里点了「取消」，或新建后没点「确定」）→ 注册表里没有；
 *   ② 保存了但当前进程没继承（已开着的终端 / 应用要重启）→ 注册表里有、`process.env` 里没有。
 *
 * @param name 变量名
 * @returns 命中且非空时返回值，否则 null
 */
function readUserEnvFromRegistry(name) {
  const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
  if (!out || out.status !== 0 || typeof out.stdout !== 'string') {
    return null;
  }
  // reg 输出形如「名字    REG_SZ    值」；API key 是纯 ASCII，按 UTF-8 读即可。
  const m = /REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]*)/.exec(out.stdout);
  const value = m ? m[1].trim() : '';
  return value.length > 0 ? value : null;
}

/** Windows 用户变量里是否有这个名字（不看值，只用于诊断「没保存」还是「没继承」）。 */
function userEnvExists(name) {
  const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
  return !!out && out.status === 0;
}

/**
 * 读 key，三个来源按优先级：进程环境变量 → `.secrets/deepseek.key` → Windows 用户变量。
 *
 * @returns key（空串=没配）、来源说明、是否只来自注册表
 */
function readKey() {
  const fromEnv = (process.env.DEEPSEEK_API_KEY || process.env.HOGO_LLM_KEY || '').trim();
  if (fromEnv.length > 0) {
    return { key: fromEnv, source: '进程环境变量', fromRegistryOnly: false };
  }
  const file = path.join(ROOT, '.secrets', 'deepseek.key');
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text.length > 0) {
      return { key: text, source: file, fromRegistryOnly: false };
    }
  } catch { /* 没这个文件 */ }
  for (const name of ['DEEPSEEK_API_KEY', 'HOGO_LLM_KEY']) {
    const fromReg = readUserEnvFromRegistry(name);
    if (fromReg) {
      return { key: fromReg, source: 'Windows 用户变量 ' + name, fromRegistryOnly: true };
    }
  }
  return { key: '', source: '', fromRegistryOnly: false };
}

const { key: KEY, source: KEY_SOURCE, fromRegistryOnly: KEY_FROM_REGISTRY } = readKey();
const BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();

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

/** 造一份 CSV：外壳长度第 7 子组抬高（越 UCL），转轴直径正常。 */
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

async function listModels(report) {
  try {
    const r = await fetch(BASE + '/models', { headers: { Authorization: 'Bearer ' + KEY } });
    const text = await r.text();
    report.models = { status: r.status, body: text.slice(0, 1200) };
    let ids = [];
    try {
      const j = JSON.parse(text);
      ids = (j.data || []).map((m) => m.id).filter(Boolean);
    } catch { /* 非 JSON：原文已留档 */ }
    report.modelIds = ids;
    return ids;
  } catch (e) {
    report.models = { error: String((e && e.message) || e) };
    return [];
  }
}

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

const BUBBLES_EXPR = `(function(){
  return [].slice.call(document.querySelectorAll('[data-testid="ai-message-assistant"]')).map(function(m){ return m.innerText; });
})()`;

async function main() {
  const report = { mode: 'p9-real-llm', model: MODEL, base: BASE, keySource: KEY_SOURCE, asserts: [], ok: null };

  if (KEY.length === 0) {
    console.log('SKIP  没有配 key。探针按「进程环境变量 → .secrets/deepseek.key → Windows 用户变量」三处找，不碰仓库其它文件。');
    console.log('      1) 写文件（最快，且不需要重启任何东西）：E:\\tools\\Hogo-QA-tool\\.secrets\\deepseek.key');
    console.log('      2) 临时给本会话：  $env:DEEPSEEK_API_KEY = \'sk-你的key\'; node .probe/p9-real-llm.mjs');
    console.log('      3) Windows「环境变量」对话框新建用户变量 DEEPSEEK_API_KEY —— **必须点「确定」**才落盘。');
    if (!userEnvExists('DEEPSEEK_API_KEY') && !userEnvExists('HOGO_LLM_KEY')) {
      console.log('      诊断：注册表 HKCU\\Environment 里**确实没有** DEEPSEEK_API_KEY ——');
      console.log('            也就是说它在 Windows 层面还没保存（对话框列表里看得到 ≠ 已保存；');
      console.log('            只点「取消」或直接关窗口都不会写入注册表）。');
    } else {
      console.log('      诊断：注册表里**有**这个变量，但当前进程没继承到（已开着的终端 / 应用需重启）。');
    }
    console.log('      注意：这个变量只对**探针**有用 —— 浏览器页面读不到 Windows 环境变量，');
    console.log('            应用里的 key 要在「设置」页填（只存本机 localStorage）。');
    process.exit(2);
  }
  console.log('key 来源：' + KEY_SOURCE + '（长度 ' + KEY.length + '，不回显）');
  if (KEY_FROM_REGISTRY) {
    console.log('      注意：它来自 Windows 用户变量，本进程环境里并没有（已开着的终端继承不到）。');
    console.log('      另外这只对探针有效：应用里的 key 必须在「设置」页填（页面读不到 Windows 环境变量）。');
  }

  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });

  // ---- 1) 真实模型名 ----
  const ids = await listModels(report);
  console.log('— 服务端可用模型：' + (ids.length > 0 ? ids.join(', ') : '（未能列出，见 .probe/p9-real-llm.json 原文）'));
  if (ids.length > 0) {
    check('设置里的模型名在服务端真实存在', ids.includes(MODEL), 'model=' + MODEL + ' 可用=' + ids.join('/'));
    if (!ids.includes(MODEL)) {
      console.log('  ✗「' + MODEL + '」不在服务端清单里 —— 这正是 HTTP 400 的头号原因；');
      console.log('    请把「设置」页模型名改成上面清单里的一个（官方通常是 deepseek-chat / deepseek-reasoner）。');
    }
  }

  // ---- 2) 预检 ----
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

  // ---- 3) 真机 ----
  const profile = path.join(os.tmpdir(), 'hogo-p9real-' + Date.now());
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

    const waitEval = async (expr, label, timeout = 180000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        try { if (await cdp.eval(expr)) return true; } catch { /* retry */ }
        await sleep(400);
      }
      throw new Error('timeout ' + label);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载', 40000);
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

    // 侧栏进 AI 助手（客户端路由，别整页跳转丢 dataset）
    await cdp.eval(`(function(){
      var a = document.querySelector('[data-testid="app-sidebar"] a[href="/ai"]');
      a.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="ai-assistant-page"]\')', 'AI 助手页', 30000);
    await sleep(1000);

    // ---- 3a) 数据问答：必须点名子组编号与判异规则 ----
    await cdp.eval(`(function(){
      var el = document.querySelector('input[aria-label="数据问答输入"]');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '这批数据里第几子组触发了哪条判异规则？请点名特性与子组编号。');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      var btn = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent.trim() === '提问'; })[0];
      btn.click(); return true;
    })()`);
    await waitEval('document.querySelectorAll(\'[data-testid^="ai-message-"]\').length >= 2', '问答回复', 180000);
    await sleep(1500);
    const qaReply = (await cdp.eval(BUBBLES_EXPR)).pop() || '';
    report.qaReply = qaReply;
    check('问答：真模型回了内容', qaReply.trim().length > 20, 'len=' + qaReply.length);
    check('问答：点名了具体子组编号', /第\s*7\s*个子组|子组\s*7|subgroup\s*7/i.test(qaReply));
    check('问答：给出了判异规则编号（W1…W4 / N1…N8）', /W[1-4]|N[1-8]/.test(qaReply));
    const qaDodge = DODGE_PATTERNS.filter((p) => qaReply.includes(p));
    check('问答：没有「摘要未提供 / 数据不足」这类推诿话术', qaDodge.length === 0, qaDodge.join('、'));
    check('问答：正文里没有露出 [[chart:…]] 标记', qaReply.indexOf('[[chart:') < 0);

    // ---- 3b) 一键全面诊断：五节必须齐全 ----
    await cdp.eval(`(function(){
      var t = document.querySelector('[data-testid="ai-toggle-tools"]');
      if (t) { t.click(); }
      return true;
    })()`);
    await sleep(500);
    await cdp.eval(`(function(){
      var b = document.querySelector('[data-testid="ai-action-fullDiagnosis"]');
      b.click(); return true;
    })()`);
    await waitEval('!!document.querySelector(\'[data-testid="ai-full-diagnosis"]\')', '全面诊断报告卡', 180000);
    await sleep(1000);
    const dxText = await cdp.eval(`(function(){
      var card = document.querySelector('[data-testid="ai-full-diagnosis"]');
      return card ? card.innerText : '';
    })()`);
    report.diagnosisText = dxText;
    const missing = SECTIONS.filter((s) => !dxText.includes(s));
    check('全面诊断：五节标题齐全（总体结论/过程能力盘点/主要问题与疑似根因/改善行动/数据局限与风险提示）',
      missing.length === 0, missing.length > 0 ? '缺少：' + missing.join('、') : '');
    check('全面诊断：报告有实质长度（> 400 字）', dxText.length > 400, 'len=' + dxText.length);
    const dxDodge = DODGE_PATTERNS.filter((p) => dxText.includes(p));
    check('全面诊断：没有「摘要未提供 / 数据不足」这类推诿话术', dxDodge.length === 0, dxDodge.join('、'));
    check('全面诊断：报告里没有露出 [[chart:…]] 标记', dxText.indexOf('[[chart:') < 0);
    check('全面诊断：报告已持久化（顶栏出现「诊断报告（已保存）」入口）',
      await cdp.eval('!!document.querySelector(\'[data-testid="ai-open-diagnosis"]\')'));

    await cdp.shot(path.join(OUT, 'p9-real-llm.png'));
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String((e && e.stack) || e);
    report.ok = false;
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
  }

  fs.writeFileSync(path.join(OUT, 'p9-real-llm.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const a of report.asserts) console.log((a.pass ? 'PASS  ' : 'FAIL  ') + a.name + (a.detail ? '  [' + a.detail + ']' : ''));
  if (report.error) console.log('ERROR: ' + report.error);
  console.log('RESULT ok=' + report.ok + '  passed=' + report.asserts.filter((a) => a.pass).length + '/' + report.asserts.length);
  process.exit(report.ok ? 0 : 1);
}

main();