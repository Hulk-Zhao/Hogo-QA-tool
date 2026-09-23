/**
 * p11-http-import-library —— 真机验收（**start.bat 的实际路径：本地 HTTP**）：
 * 「导入 xlsx → 项目库有数据」，并顺带守住「服务端给的不是旧产物」。
 *
 * 为什么要有这一条（本轮用户报障的根因）：`start.bat` 原先只在
 * `dist-server\index.html` 不存在时才构建，于是它一直服务昨天的 bundle ——
 * 用户重启 start.bat 后跑的还是旧代码，得出「导入仍然失败」的结论。
 * 本脚本因此同时断言两件事：
 *   1. 服务端**真的**在发新代码（bundle 里含本轮新增文案）；
 *   2. 真机跑通「导入 xlsx（3 特性 × 50 = 150 测量值 + 6 类不良）→ 项目库 1 条 → 刷新后仍在」。
 *
 * 端口用 8791（避开用户正在跑的 start.bat:8787）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import XLSX from 'xlsx';
import { CHROME } from './_env.mjs';

const ROOT = 'E:/tools/Hogo-QA-tool';
const XLSX_PATH = ROOT + '/.probe/p11-sample.xlsx';
const PORT = 8791;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const CDP_PORT = 9232;
const PROFILE = ROOT + '/.probe/p11-profile';
const OUT = ROOT + '/.probe/p11-http-import-library.json';
const SHOT_LIBRARY = ROOT + '/.probe/p11-library.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成「旧工具双 sheet 格式」样本：3 特性 × 50 行 = 150 测量值 + 6 类不良。 */
function makeSample() {
  const dim = [['物料名称', '测量值', 'USL', 'LSL']];
  const push = (name, base, usl, lsl, amp) => {
    for (let i = 0; i < 50; i += 1) {
      const v = (base + Math.sin(i * 0.7) * amp + (i % 5) * 0.003).toFixed(4);
      dim.push([name, Number(v), usl, lsl]);
    }
  };
  push('外壳长度', 50.0, 50.2, 49.8, 0.03);
  push('转轴直径', 12.0, 12.02, 11.98, 0.006);
  push('端面跳动', 0.05, 0.08, 0.02, 0.004);

  const defect = [
    ['不良类型', '不良数量'],
    ['毛刺', 42],
    ['尺寸超差', 27],
    ['划伤', 18],
    ['变形', 9],
    ['其他', 5],
    ['气孔', 3],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dim), '尺寸数据');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(defect), '不良数据');
  XLSX.writeFile(wb, XLSX_PATH, { bookType: 'xlsx' });
  return { measurements: 150, defectTypes: 6, file: XLSX_PATH };
}

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
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    await sleep(300);
  }
}

async function shot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path, Buffer.from(r.result.data, 'base64'));
}

/** 读项目库：条目数 / 名称 / 是否空态 / 是否走了降级链。 */
async function readLibrary(cdp) {
  // 注意：HTTP 下应用用 **BrowserRouter**（file:// 才用 HashRouter），
  // 改 location.hash 不会触发路由 —— 必须走真实导航。
  await navigate(cdp, 'library');
  await waitFor(cdp, `!!document.querySelector('[data-testid="project-library-page"]')`, 20000, 'library page');
  await waitFor(
    cdp,
    `!!document.querySelector('[data-testid="project-list"]') || document.body.innerText.includes('暂无项目')`,
    20000,
    'library resolved',
  );
  return evaluate(cdp, `(() => {
    const page = document.querySelector('[data-testid="project-library-page"]');
    const items = [...document.querySelectorAll('[data-testid^="project-item-"]')];
    return {
      empty: (page.innerText || '').includes('暂无项目'),
      count: items.length,
      names: items.map((el) => (el.innerText || '').split('\\n')[0].trim()),
      degraded: !!document.querySelector('[data-testid="library-degraded"]'),
      emptyCopy: (page.innerText || '').includes('项目会自动保存'),
    };
  })()`);
}

/** 真实导航（BrowserRouter：必须改 path，不能只改 hash）。 */
async function navigate(cdp, path) {
  await cdp.send('Page.navigate', { url: APP_URL + path });
  await waitFor(
    cdp,
    `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`,
    30000,
    'app mount @' + path,
  );
}

const fixture = makeSample();
const server = spawn('node', [ROOT + '/scripts/serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
const result = { ok: false, fixture, steps: {} };
try {
  // 等本地服务起来
  let up = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(300);
  }
  if (!up) throw new Error('serve.mjs 没起来');

  // 守住「服务端发的是新代码」：直接抓 bundle 文本找本轮新增文案。
  const indexHtml = await (await fetch(APP_URL)).text();
  const bundlePath = (indexHtml.match(/src="\.?\/?(assets\/[^"]+\.js)"/) || [])[1];
  result.steps.servedBundle = { bundlePath: bundlePath || null };
  if (bundlePath) {
    const bundle = await (await fetch(APP_URL + bundlePath)).text();
    result.steps.servedBundle.hasNewCopy = bundle.includes('项目会自动保存');
    result.steps.servedBundle.hasSaveToast = bundle.includes('已保存到项目库');
    result.steps.servedBundle.hasOldCopy = bundle.includes('导入数据并保存后');
  }

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
  await cdp.send('DOM.enable');
  await navigate(cdp, 'import');

  // 清干净两种后端，保证可重复运行
  result.steps.reset = await evaluate(cdp, `(async () => {
    localStorage.clear();
    const dbs = (await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]))) || [];
    await Promise.all(dbs.map((d) => new Promise((res) => {
      if (!d.name) return res('skip');
      const req = indexedDB.deleteDatabase(d.name);
      req.onsuccess = req.onerror = req.onblocked = () => res(d.name);
    })));
    return 'cleared:' + dbs.map((d) => d.name).join(',');
  })()`);
  await evaluate(cdp, `location.reload(); 'reloading'`);
  await sleep(1500);
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 30000, 'app remount');

  result.steps.before = await readLibrary(cdp);

  // ---- 走用户的实际路径：数据导入页 → 选 xlsx 文件（真实 file input） ----
  await navigate(cdp, 'import');
  await waitFor(cdp, `!!document.querySelector('input[type="file"]')`, 20000, 'file input');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type="file"]',
  });
  await cdp.send('DOM.setFileInputFiles', { files: [XLSX_PATH], nodeId: q.result.nodeId });

  await waitFor(cdp, `document.body.innerText.includes('校验结果')`, 25000, 'validation card');
  result.steps.validation = await evaluate(cdp, `(() => {
    const t = document.querySelector('[data-testid="import-page"]').innerText || '';
    const grab = (label) => {
      const m = t.match(new RegExp(label + '[^0-9]{0,6}([0-9]+)'));
      return m ? Number(m[1]) : null;
    };
    return { characteristics: grab('特性数'), measurements: grab('测量数'), defectTypes: grab('缺陷类型数') };
  })()`);

  const confirm = await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '确认导入并分析');
    if (!btn) return 'NO_CONFIRM_BTN';
    if (btn.disabled) return 'CONFIRM_DISABLED';
    btn.click();
    return 'confirmed';
  })()`);
  result.steps.confirm = confirm;

  result.steps.toast = await waitFor(
    cdp,
    `(() => {
      const t = document.body.innerText || '';
      return t.includes('已保存到项目库') ? '已保存到项目库' : null;
    })()`,
    25000,
    'save toast',
  );
  result.steps.alerts = await evaluate(
    cdp,
    `[...document.querySelectorAll('[role="alert"]')].map((n) => (n.innerText || '').trim()).slice(0, 3)`,
  );

  result.steps.afterImport = await readLibrary(cdp);
  await shot(cdp, SHOT_LIBRARY);
  result.steps.topbarAfterImport = await evaluate(
    cdp,
    `(() => (document.querySelector('[aria-label="重命名项目"]')?.parentElement?.innerText || '').trim())()`,
  );

  // ---- 刷新后仍在 ----
  await evaluate(cdp, `location.reload(); 'reload'`);
  await sleep(1500);
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 30000, 'app remount 2');
  result.steps.afterReload = await readLibrary(cdp);
  result.steps.topbarAfterReload = await evaluate(
    cdp,
    `(() => (document.querySelector('[aria-label="重命名项目"]')?.parentElement?.innerText || '').trim())()`,
  );

  const s = result.steps;
  result.assertions = {
    // 服务端必须发新代码（这条是本次用户报障的直接根因，必须显式守住）
    servedBundleIsFresh: s.servedBundle.hasNewCopy === true && s.servedBundle.hasOldCopy === false,
    libraryEmptyBefore: s.before.empty === true && s.before.count === 0,
    validationMatchesFixture:
      s.validation.characteristics === 3 &&
      s.validation.measurements === 150 &&
      s.validation.defectTypes === 6,
    savedToastShown: s.toast === '已保存到项目库',
    libraryHasOneAfterImport: s.afterImport.count === 1 && s.afterImport.empty === false,
    projectNamedAfterFile: (s.afterImport.names[0] || '').includes('p11-sample'),
    indexedDbBackendUsed: s.afterImport.degraded === false,
    persistedAcrossReload: s.afterReload.count === 1,
    lastProjectRestored: (s.topbarAfterReload || '').includes('p11-sample'),
  };
  result.ok = Object.values(result.assertions).every(Boolean);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, assertions: result.assertions, steps: s }, null, 2));
} catch (e) {
  result.error = String(e && e.message ? e.message : e);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('PROBE FAILED: ' + result.error);
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
}