/**
 * p10-import-library —— 真机验收：**「导入数据 → 项目库有数据」**（本轮 P0 修复）。
 *
 * 为什么必须真机跑：这条缺陷在 jsdom 里永远看不见 —— 导入页不写仓库、
 * 项目 id 又硬编码成同一个常量，两处都是「接线类缺陷」，只有真正走一遍
 * 构建产物里的客户端（file:// 双击离线包）才能证明它确实修好了。
 *
 * 用 file:// 直开 dist/index.html（用户的主路径）。脚本会记录实际走的是
 * 哪个后端（`degraded`）—— 实测 Chrome 的 file:// 下 IndexedDB 可用，
 * 所以双击打开时通常**不是**降级链；降级链由单测覆盖
 * （见 src/ui/__tests__/ImportPage.spec.tsx）。
 *
 * 断言：
 *  1. 首次导入后项目库出现 1 条（此前永远是「暂无项目」）；
 *  2. 再导入一次 → 2 条（此前会静默覆盖成 1 条）；
 *  3. 刷新后仍是 2 条，且顶栏恢复出「上次项目」的名字（持久化 + 启动恢复）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { CHROME } from './_env.mjs';

const APP_URL = 'file:///E:/tools/Hogo-QA-tool/dist/index.html';
const CDP_PORT = 9231;
const PROFILE = 'E:/tools/Hogo-QA-tool/.probe/p10-profile';
const OUT = 'E:/tools/Hogo-QA-tool/.probe/p10-import-library.json';
const SHOT_LIBRARY = 'E:/tools/Hogo-QA-tool/.probe/p10-library.png';
const SHOT_IMPORT = 'E:/tools/Hogo-QA-tool/.probe/p10-import-toast.png';

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

async function shot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path, Buffer.from(r.result.data, 'base64'));
}

/** 走一遍「粘贴 CSV → 解析 → 确认导入」。 */
async function importViaPaste(cdp, text) {
  await evaluate(cdp, `location.hash = '#/import'; 'go-import'`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="drop-zone"]')`, 15000, 'import page');

  const clickedTab = await evaluate(cdp, `(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '粘贴 CSV');
    if (!tab) return 'NO_TAB';
    tab.click();
    return 'tab-clicked';
  })()`);

  await waitFor(cdp, `!!document.querySelector('[data-testid="paste-input"]')`, 10000, 'paste textarea');
  await evaluate(cdp, `(() => {
    const ta = document.querySelector('[data-testid="paste-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);

  await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '解析');
    if (!btn) return 'NO_PARSE_BTN';
    btn.click();
    return 'parsed';
  })()`);

  await waitFor(cdp, `document.body.innerText.includes('校验结果')`, 15000, 'validation card');
  const disabled = await evaluate(cdp, `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '确认导入并分析');
    if (!btn) return 'NO_CONFIRM_BTN';
    if (btn.disabled) return 'CONFIRM_DISABLED';
    btn.click();
    return 'confirmed';
  })()`);

  return { clickedTab, confirm: disabled };
}

/** 读项目库：条目数 + 名称 + 是否仍是空态。 */
async function readLibrary(cdp) {
  await evaluate(cdp, `location.hash = '#/library'; 'go-library'`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="project-library-page"]')`, 15000, 'library page');
  // 等列表或空态出现（异步 listProjects 需要一拍）
  await waitFor(
    cdp,
    `!!document.querySelector('[data-testid="project-list"]') || document.body.innerText.includes('暂无项目')`,
    15000,
    'library resolved',
  );
  return evaluate(cdp, `(() => {
    const page = document.querySelector('[data-testid="project-library-page"]');
    const items = [...document.querySelectorAll('[data-testid^="project-item-"]')];
    return {
      empty: (page.innerText || '').includes('暂无项目'),
      count: items.length,
      names: items.map((el) => (el.innerText || '').split('\\n')[0].trim()),
      // 降级横幅存在 => 没用上 IndexedDB（走了 localStorage / 内存降级链）。
      degraded: !!document.querySelector('[data-testid="library-degraded"]'),
    };
  })()`);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=1400,1000`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
const result = { ok: false, steps: {} };
try {
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
  await cdp.send('Page.navigate', { url: APP_URL + '#/import' });
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 30000, 'app mount');

  // 清干净两种后端（脚本必须可重复运行）：localStorage + 所有 IndexedDB 库。
  // 实测 Chrome 的 file:// 下 IndexedDB 是可用的，所以「双击 dist/index.html」
  // 走的往往是 IndexedDB 而不是 localStorage —— 两处都要清。
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

  // ---- 第一次导入 ----
  result.steps.import1 = await importViaPaste(
    cdp,
    '物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05\n外壳长度,10.01\n转轴直径,5.01\n转轴直径,5.03',
  );
  const toast1 = await waitFor(
    cdp,
    `document.body.innerText.includes('已保存到项目库') ? document.body.innerText.slice(0, 400) : null`,
    20000,
    'save toast',
  );
  result.steps.toast1 = toast1;
  result.steps.importHint = await evaluate(
    cdp,
    `(() => {
      const t = document.body.innerText;
      const el = [...document.querySelectorAll('[role="alert"]')].map((n) => (n.innerText || '').trim());
      return { alerts: el, degradedHintShown: t.includes('离线双击模式') };
    })()`,
  );
  await shot(cdp, SHOT_IMPORT);
  result.steps.afterImport1 = await readLibrary(cdp);

  // ---- 第二次导入（此前会被静默覆盖） ----
  result.steps.import2 = await importViaPaste(cdp, '物料名称,测量值\n主轴跳动,0.021\n主轴跳动,0.019\n主轴跳动,0.023');
  await waitFor(cdp, `document.body.innerText.includes('已保存到项目库')`, 20000, 'save toast 2');
  result.steps.afterImport2 = await readLibrary(cdp);
  await shot(cdp, SHOT_LIBRARY);

  // ---- 刷新后仍在（持久化 + 启动恢复） ----
  await evaluate(cdp, `location.hash = '#/import'; location.reload(); 'reload'`);
  await sleep(1500);
  await waitFor(cdp, `document.querySelector('#root') && document.querySelector('#root').innerText.length > 50`, 30000, 'app remount 2');
  result.steps.afterReload = await readLibrary(cdp);
  result.steps.topbarAfterReload = await evaluate(
    cdp,
    `(() => (document.querySelector('[aria-label="重命名项目"]')?.parentElement?.innerText || '').trim())()`,
  );

  const s = result.steps;
  result.assertions = {
    libraryEmptyBeforeFix: s.before.empty === true && s.before.count === 0,
    oneAfterFirstImport: s.afterImport1.count === 1 && s.afterImport1.empty === false,
    twoAfterSecondImport: s.afterImport2.count === 2,
    persistedAcrossReload: s.afterReload.count === 2,
    lastProjectRestored: (s.topbarAfterReload || '').length > 0 && !(s.topbarAfterReload || '').includes('未命名项目'),
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
}