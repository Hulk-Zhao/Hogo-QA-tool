/**
 * p13-readme-shots —— 给 README 拍「产品实际界面」截图。
 *
 * 为什么需要它：README 长期只有文字，读者看不到产品长什么样。
 * 手截的图会过期、也没法复现；这里把取图过程脚本化 —— 任何人在自己机器上
 * `node .probe/p13-readme-shots.mjs` 都能得到同一批图（同一份样本数据、同一套页面）。
 *
 * 与 p11 的关系：p11 验收「导入 → 项目库」，本脚本复用它已经跑通的路径
 * （本地 HTTP + 真实 input[type=file] 上传），只是把终点从「断言」换成「截图」。
 * 数据用仓库入库的同一份样本 `samples/hogo-qa-sample.xlsx`，
 * 于是 README 上的截图与 README 里的样本表格讲的是同一组数字。
 *
 * 端口 8793 / CDP 9233（避开 8787 的 start.bat 与 p10/p11 的 9231/9232）。
 *
 * 用法：
 *   node scripts/ensure-build.mjs           # 先确保 dist-server 是当前源码
 *   node .probe/p13-readme-shots.mjs
 * 产物：docs/images/01-import.png ... 06-library.png（**入库**，README 直接引用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { CHROME, CHROME_SOURCE } from './_env.mjs';

const ROOT = process.env.HOGO_ROOT || 'E:/tools/Hogo-QA-tool';
const XLSX_PATH = ROOT + '/samples/hogo-qa-sample.xlsx';
const OUT_DIR = ROOT + '/docs/images';
const PORT = 8793;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const CDP_PORT = 9233;
const PROFILE = ROOT + '/.probe/p13-profile';

/** 视口：1440 宽在 GitHub 上缩放后仍能看清表头，高度取到「一屏能讲完一个功能点」。 */
const VIEWPORT = { width: 1440, height: 1120 };

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

/** 真实导航（HTTP 下应用用 BrowserRouter：改 hash 不会触发路由）。 */
async function navigate(cdp, path) {
  await cdp.send('Page.navigate', { url: APP_URL + path });
  await waitFor(
    cdp,
    `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`,
    30000,
    'app mount @' + path,
  );
}

/**
 * 截图。`anchorTestId` 给定时先把该元素滚到视口顶部 ——
 * 主内容区是 `overflow:auto` 的容器，`window.scrollTo` 对它无效，必须用 scrollIntoView。
 */
/**
 * 截图。`height` 逐页手填 —— 每页的「一个功能点」正好在哪结束是量出来的
 * （见下面各调用点的注释），用一个通用规则反而会切掉表格或留下半屏空白：
 * 内容比视口高时保留一屏（宁可滚动条露出来，也要让底部落在区块间隙里），
 * 内容比视口矮时把视口压矮（避免整片空白）。
 * `anchorTestId` 给定时先把该元素滚到视口顶部（主内容区是 `overflow:auto`
 * 的容器，`window.scrollTo` 对它无效，必须用 scrollIntoView）。
 */
async function shot(cdp, name, anchorTestId, height = VIEWPORT.height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (anchorTestId) {
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('[data-testid="${anchorTestId}"]');
        if (!el) return 'no-anchor';
        el.scrollIntoView({ block: 'start', behavior: 'instant' });
        return 'scrolled';
      })()`,
    );
    await sleep(700);
  }
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = OUT_DIR + '/' + name + '.png';
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const bytes = fs.statSync(file).size;
  console.log('  shot ' + name + '.png  ' + Math.round(bytes / 1024) + ' KB');
  return { name, bytes };
}

/** 页面上有没有画出来的图（ECharts canvas 有非零尺寸才算）。 */
const CHART_DRAWN = (testId) => `(() => {
  const el = document.querySelector('[data-testid="${testId}"]');
  if (!el) return false;
  const c = el.querySelector('canvas');
  return !!(c && c.width > 100 && c.height > 100);
})()`;

const server = spawn('node', [ROOT + '/scripts/serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
const result = { ok: false, chrome: CHROME, chromeSource: CHROME_SOURCE, shots: [] };
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(XLSX_PATH)) throw new Error('缺样本文件：' + XLSX_PATH + '（先跑 node samples/make-sample.mjs）');

  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(300);
  }
  if (!up) throw new Error('serve.mjs 没起来（端口 ' + PORT + ' 被占？）');

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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate(cdp, 'import');

  // 清干净两种后端，保证每次跑出来的图一致（不受上一次遗留项目影响）
  await evaluate(cdp, `(async () => {
    localStorage.clear();
    const dbs = (await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]))) || [];
    await Promise.all(dbs.map((d) => new Promise((res) => {
      if (!d.name) return res('skip');
      const req = indexedDB.deleteDatabase(d.name);
      req.onsuccess = req.onerror = req.onblocked = () => res(d.name);
    })));
    return 'cleared';
  })()`);
  await evaluate(cdp, `location.reload(); 'reloading'`);
  await sleep(1500);
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 30000, 'app remount');

  // ---- 导入样本：走用户的实际路径（真实 file input） ----
  await navigate(cdp, 'import');
  await waitFor(cdp, `!!document.querySelector('input[type="file"]')`, 20000, 'file input');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type="file"]',
  });
  await cdp.send('DOM.setFileInputFiles', { files: [XLSX_PATH], nodeId: q.result.nodeId });
  await waitFor(cdp, `document.body.innerText.includes('校验结果')`, 25000, 'validation card');
  await sleep(400);
  result.shots.push(await shot(cdp, '01-import', 'import-page'));

  const confirm = await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '确认导入并分析');
    if (!btn || btn.disabled) return 'NO_CONFIRM_BTN';
    btn.click();
    return 'confirmed';
  })()`);
  if (confirm !== 'confirmed') throw new Error('确认导入按钮不可用：' + confirm);
  await waitFor(cdp, `(document.body.innerText || '').includes('已保存到项目库')`, 25000, 'save toast');

  // ---- 能力分析 ----
  await navigate(cdp, 'capability');
  await waitFor(cdp, `!!document.querySelector('[data-testid="capability-table"]')`, 25000, 'capability table');
  await waitFor(cdp, CHART_DRAWN('histogram-chart'), 20000, 'histogram drawn');
  await sleep(500);
  result.shots.push(await shot(cdp, '02-capability', 'capability-page', 1340));

  // ---- 控制图（带判异） ----
  await navigate(cdp, 'control-chart');
  await waitFor(cdp, CHART_DRAWN('control-chart'), 25000, 'control chart drawn');
  await waitFor(cdp, `!!document.querySelector('[data-testid="rule-violation-table"]')`, 20000, 'violation table');
  await sleep(600);
  result.shots.push(await shot(cdp, '03-control-chart', 'control-chart-page'));

  // ---- 柏拉图 ----
  await navigate(cdp, 'pareto');
  await waitFor(cdp, CHART_DRAWN('pareto-chart'), 25000, 'pareto drawn');
  await sleep(600);
  result.shots.push(await shot(cdp, '04-pareto', 'pareto-page'));

  // ---- 报表 ----
  await navigate(cdp, 'report');
  await waitFor(cdp, `!!document.querySelector('[data-testid="report-charts"]')`, 25000, 'report page');
  await sleep(1200);
  result.shots.push(await shot(cdp, '05-report', 'report-page', 1560));

  // ---- 项目库 ----
  await navigate(cdp, 'library');
  await waitFor(cdp, `!!document.querySelector('[data-testid="project-list"]')`, 25000, 'project list');
  await sleep(400);
  result.shots.push(await shot(cdp, '06-library', 'project-library-page', 430));

  // 每张图都必须有实际内容（PNG 太小 = 白屏/纯色，直接判失败而不是把空图提交进 README）
  const tooSmall = result.shots.filter((s) => s.bytes < 20000);
  result.assertions = {
    shotCount: result.shots.length === 6,
    noneBlank: tooSmall.length === 0,
  };
  result.ok = result.shots.length === 6 && tooSmall.length === 0;
  console.log(JSON.stringify({ ok: result.ok, assertions: result.assertions, shots: result.shots }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (e) {
  console.error('PROBE FAILED: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { cdp && cdp.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
}