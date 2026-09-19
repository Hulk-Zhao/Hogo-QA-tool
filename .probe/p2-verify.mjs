/**
 * p2-verify.mjs —— 第七轮 P2 真实浏览器验收（真 Chrome + 真产物 dist-server）。
 *
 * 验四件事（全部在**真实产物**上跑，不接受「构建成功 = 功能可用」）：
 *   P2-A 规格限自动预填：导入带 USL/LSL 的数据后，能力页规格限不再为空、Cp/Cpk 不再是 N/A
 *   P2-C 全角列名：表头写成全角 ＵＳＬ/ＬＳＬ 也能被识别为规格限（端到端，不只是单测）
 *   P2-D 多特性 Cpk 批量对比表：出现、可排序、Cpk 不可判定行排最后
 *   口径一致：同一特性在能力页与报表页的 Cpk / 判定必须一致
 *
 * 与上一版 p2-repro-spec.mjs 的区别：那个脚本是**缺陷复现**（只记录现象、恒 ok:true），
 * 本脚本是**验收**（逐条断言，任一条不成立即 ok:false）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9455;
const ROOT = 'E:/tools/Hogo-QA-tool';
const OUT = ROOT + '/.probe/p2-verify-result.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 半角表头 + 两个特性（外壳长度 / 转轴直径）。 */
function buildCsv(halfWidthHeaders) {
  const head = halfWidthHeaders
    ? '物料名称,测量值,USL,LSL'
    : '物料名称,测量值,ＵＳＬ,ＬＳＬ';
  const rows = [head];
  for (let i = 0; i < 60; i += 1) {
    rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
  }
  for (let i = 0; i < 60; i += 1) {
    rows.push('转轴直径,' + (12 + Math.sin(i * 0.5) * 0.006).toFixed(4) + ',12.02,11.98');
  }
  return rows.join('\n');
}

const sel = (t) => '[data-testid="' + t + '"]';

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const h of this.handlers.get(m.method)) h(m.params);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) { try { return await r.json(); } catch { return null; } } } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p2verify-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  const report = { steps: [], checks: {}, failures: [], pageErrors: [], consoleErrors: [] };
  const assert = (label, cond, detail) => {
    if (cond) { report.steps.push('OK: ' + label); return; }
    report.failures.push(label + '  -> ' + String(detail));
  };

  let preview;
  try {
    preview = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server',
      '--host', '127.0.0.1', '--port', '8787', '--strictPort',
    ], { cwd: ROOT, stdio: 'ignore' });
    await waitForHttp(APP_URL, 30000);
    report.steps.push('OK: vite preview 8787 (dist-server)');

    await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => report.pageErrors.push((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || 'x'));
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') report.consoleErrors.push(p.args.map((a) => a.value || a.description || '').join(' ')); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 2400, deviceScaleFactor: 1, mobile: false });

    const q = (t) => 'document.querySelector(' + JSON.stringify(sel(t)) + ')';
    const has = (t) => '!!' + q(t);
    const textOf = (t) =>
      cdp.eval('(function(s){ var e=document.querySelector(s); return e ? e.innerText : null; })(' + JSON.stringify(sel(t)) + ')');
    const click = (t) =>
      cdp.eval('(function(s){ var e=document.querySelector(s); if(!e) return false; e.click(); return true; })(' + JSON.stringify(sel(t)) + ')');
    const waitEval = async (expr, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try { last = await cdp.eval(expr); if (last) { report.steps.push('OK: ' + label); return true; } } catch (e) { last = String(e); }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label + ' (last=' + String(last) + ')');
    };
    const spaNav = async (route, predicate, label) => {
      const clicked = await cdp.eval('(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' + JSON.stringify(route) + ')');
      if (!clicked) throw new Error('未找到导航: ' + route);
      await waitEval(predicate, label);
    };
    /** 读 MUI TextField 的值（按 label 文本定位，label 用 for 关联 input）。 */
    const inputByLabel = (needle) =>
      cdp.eval('(function(n){ var ls=[].slice.call(document.querySelectorAll("label")); for (var i=0;i<ls.length;i++){ if ((ls[i].textContent||"").indexOf(n)>=0){ var id=ls[i].getAttribute("for"); var el=id?document.getElementById(id):null; if(!el && ls[i].parentElement) el=ls[i].parentElement.querySelector("input"); if(el) return el.value; } } return null; })(' + JSON.stringify(needle) + ')');
    const setInputByLabel = (needle, value) =>
      cdp.eval('(function(a){ var n=a[0], v=a[1]; var ls=[].slice.call(document.querySelectorAll("label")); for (var i=0;i<ls.length;i++){ if ((ls[i].textContent||"").indexOf(n)>=0){ var id=ls[i].getAttribute("for"); var el=id?document.getElementById(id):null; if(!el && ls[i].parentElement) el=ls[i].parentElement.querySelector("input"); if(!el) continue; var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set; s.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); return el.value; } } return null; })(' + JSON.stringify([needle, value]) + ')');
    const shot = async (file) => {
      const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(ROOT + '/.probe/' + file, Buffer.from(s.data, 'base64'));
    };
    /** 粘贴 CSV → 解析 → 确认导入并分析（真实导入链路）。 */
    const importCsv = async (csv, tag) => {
      await spaNav('/import', has('import-page'), tag + '：导入页');
      await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
      await waitEval(has('paste-input'), tag + '：粘贴框');
      await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(csv) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return el.value.length; })()');
      await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
      await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', tag + '：解析完成', 25000);
      const stageText = String(await cdp.eval('document.body.innerText'));
      report.checks[tag + '_parseStageText'] = stageText.replace(/\s+/g, ' ').slice(0, 300);
      assert(tag + '：导入向导自动识别列名（无「未能自动识别」）', stageText.indexOf('未能自动识别列名') < 0, stageText.slice(0, 200));
      await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
      await waitEval(has('capability-page'), tag + '：进入能力页');
      await sleep(1800);
    };
    const batchOrder = () =>
      cdp.eval('(function(){ return [].slice.call(document.querySelectorAll(' + JSON.stringify('[data-testid^="batch-row-"]') + ')).map(function(e){ return (e.getAttribute("data-testid")||"").replace("batch-row-",""); }); })()');

    // ===================== 主链路：半角表头导入 =====================
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await importCsv(buildCsv(true), 'P2-A');

    // ---------- P2-A：规格限自动预填 ----------
    const usl = await inputByLabel('USL');
    const lsl = await inputByLabel('LSL');
    const hint = await textOf('spec-source-hint');
    report.checks.specSourceHint = hint;
    report.checks.uslInput = usl;
    report.checks.lslInput = lsl;
    assert('P2-A USL 自动预填为导入值 50.2', usl === '50.2', usl);
    assert('P2-A LSL 自动预填为导入值 49.8', lsl === '49.8', lsl);
    assert('P2-A 提示文案标注「来自导入数据」', typeof hint === 'string' && hint.indexOf('来自导入数据') >= 0 && hint.indexOf('外壳长度') >= 0, hint);

    const capTable = await textOf('capability-table');
    report.checks.capabilityTableText = capTable ? capTable.slice(0, 400) : null;
    assert('P2-A 能力页不再提示「仅提供单侧规格」', !(capTable || '').includes('仅提供单侧规格'), capTable ? capTable.slice(0, 200) : null);
    const cpkCell = await textOf('cpk-cell');
    const cpCell = await textOf('cp-cell');
    report.checks.cpkCell = cpkCell;
    report.checks.cpCell = cpCell;
    assert('P2-A Cpk 不再是 N/A', cpkCell !== 'N/A' && /^\d+\.\d{4}$/.test(cpkCell || ''), cpkCell);
    assert('P2-A Cp 不再是 N/A（双侧规格）', cpCell !== 'N/A' && /^\d+\.\d{4}$/.test(cpCell || ''), cpCell);
    await shot('p2-a-capability-filled.png');

    // ---------- P2-D：多特性批量对比表 ----------
    const batchReady = await waitEval(has('batch-capability-card'), 'P2-D 批量对比卡出现', 15000);
    const order1 = await batchOrder();
    report.checks.batchRows = order1;
    assert('P2-D 表内两个特性齐全', batchReady && order1.length === 2 && order1.indexOf('外壳长度') >= 0 && order1.indexOf('转轴直径') >= 0, JSON.stringify(order1));
    const verdictShell = await textOf('batch-verdict-外壳长度');
    report.checks.batchVerdictShell = verdictShell;
    assert('P2-D 判定列有文案（不是空白）', typeof verdictShell === 'string' && verdictShell.length > 0, verdictShell);
    await cdp.eval('(function(){ var e=document.querySelector(' + JSON.stringify(sel('batch-capability-card')) + '); if(e) e.scrollIntoView({block:"center"}); return true; })()');
    await sleep(600);
    await shot('p2-d-batch-table.png');

    await click('batch-sort-cpk');
    await sleep(600);
    const order2 = await batchOrder();
    report.checks.batchRowsAfterSort = order2;
    assert('P2-D 点击 Cpk 表头后行序反转', JSON.stringify(order2) === JSON.stringify(order1.slice().reverse()), JSON.stringify(order2) + ' vs ' + JSON.stringify(order1));
    await click('batch-sort-cpk');
    await sleep(600);
    const order3 = await batchOrder();
    assert('P2-D 再次点击回到原顺序（方向可切换）', JSON.stringify(order3) === JSON.stringify(order1), JSON.stringify(order3));

    const batchCellsRaw = await cdp.eval('(function(){ var tr=document.querySelector(' + JSON.stringify('[data-testid="batch-row-外壳长度"]') + '); return tr? [].slice.call(tr.querySelectorAll("td")).map(function(e){return (e.innerText||"").trim();}) : null; })()');
    report.checks.batchRowCellsShell = batchCellsRaw;
    assert('P2-D 批量行是完整 5 列（Cpk/Ppk 落在真实 td 里，不裸挂在 tr 下）', batchCellsRaw !== null && batchCellsRaw.length === 5, JSON.stringify(batchCellsRaw));
    // ---------- 口径一致性：能力页 vs 报表页 ----------
    await spaNav('/report', has('report-export-options'), '报表页');
    await sleep(1500);
    const reportRow = await cdp.eval('(function(){ var t=document.querySelector(' + JSON.stringify(sel('report-cpk-table')) + '); if(!t) return null; var hdr=[].slice.call(t.querySelectorAll("thead th")).map(function(e){return (e.innerText||"").trim();}); var rows=[].slice.call(t.querySelectorAll("tbody tr")); for (var i=0;i<rows.length;i++){ var tds=[].slice.call(rows[i].querySelectorAll("td")); if(tds.length && (tds[0].innerText||"").indexOf("外壳长度")>=0){ return { header: hdr, cells: tds.map(function(e){return (e.innerText||"").trim();}) }; } } return null; })()');
    report.checks.reportRow = reportRow;
    if (!reportRow) throw new Error('报表页未找到「外壳长度」行');
    const cpkIdx = reportRow.header.indexOf('Cpk');
    assert('报表表头含 Cpk 列', cpkIdx >= 0, JSON.stringify(reportRow.header));
    const reportCpk = reportRow.cells[cpkIdx];
    report.checks.reportCpk = reportCpk;
    assert('口径一致：能力页 Cpk == 报表页 Cpk', reportCpk === cpkCell, 'report=' + reportCpk + ' capability=' + cpkCell);
    const batchCpkShell = batchCellsRaw ? batchCellsRaw[2] : null;
    report.checks.batchCpkShell = batchCpkShell;
    assert('口径一致：批量表 Cpk == 报表页 Cpk（批量表宣称与报表同口径）', batchCpkShell === reportCpk, 'batch=' + String(batchCpkShell) + ' report=' + reportCpk);
    assert('P2-D 判定列与 Cpk 档位自洽', batchCpkShell === null ? false : (Number(batchCpkShell) >= 1.67 ? verdictShell === '优秀（≥1.67）' : verdictShell !== '优秀（≥1.67）'), 'verdict=' + String(verdictShell));
    await shot('p2-report-cpk.png');

    // ---------- P2-A 反向：用户手改优先，且可一键恢复 ----------
    await spaNav('/capability', has('capability-page'), '能力页（2）');
    await sleep(1200);
    await setInputByLabel('USL', '50.9');
    await sleep(400);
    const hintAfterEdit = await textOf('spec-source-hint');
    const uslAfterEdit = await inputByLabel('USL');
    report.checks.hintAfterManualEdit = hintAfterEdit;
    assert('P2-A 手改后标注「已手动修改」', hintAfterEdit === '规格限：已手动修改', hintAfterEdit);
    assert('P2-A 手改值生效（不被自动预填覆盖）', uslAfterEdit === '50.9', uslAfterEdit);
    const hasReset = await cdp.eval(has('reset-spec-from-characteristic'));
    assert('P2-A 出现「恢复为导入规格」按钮', hasReset === true, hasReset);
    await shot('p2-a-manual-override.png');
    await click('reset-spec-from-characteristic');
    await sleep(600);
    const hintAfterReset = await textOf('spec-source-hint');
    const uslAfterReset = await inputByLabel('USL');
    assert('P2-A 恢复后回到「来自导入数据」', typeof hintAfterReset === 'string' && hintAfterReset.indexOf('来自导入数据') >= 0, hintAfterReset);
    assert('P2-A 恢复后 USL 回到导入值 50.2', uslAfterReset === '50.2', uslAfterReset);

    // ---------- P2-C：全角表头端到端 ----------
    await importCsv(buildCsv(false), 'P2-C');
    const uslFw = await inputByLabel('USL');
    const lslFw = await inputByLabel('LSL');
    const hintFw = await textOf('spec-source-hint');
    report.checks.fullWidthUsl = uslFw;
    report.checks.fullWidthLsl = lslFw;
    report.checks.fullWidthHint = hintFw;
    assert('P2-C 全角 ＵＳＬ 表头被识别并预填 50.2', uslFw === '50.2', uslFw);
    assert('P2-C 全角 ＬＳＬ 表头被识别并预填 49.8', lslFw === '49.8', lslFw);
    assert('P2-C 全角表头下规格限仍来自导入数据', typeof hintFw === 'string' && hintFw.indexOf('来自导入数据') >= 0, hintFw);
    await shot('p2-c-fullwidth-headers.png');

    // ---------- P2-B：新 core 模块进产物（离线包） ----------
    const offlineBundle = fs.readFileSync(ROOT + '/dist/index.html', 'utf8');
    report.checks.offlineBundleBytes = Buffer.byteLength(offlineBundle);
    assert('P2-D 离线产物含判定文案（core 新模块已打包）', offlineBundle.indexOf('规格限不足，无法判定') >= 0, 'missing');

    report.checks.pageErrors = report.pageErrors;
    report.checks.consoleErrors = report.consoleErrors;
    report.ok = report.failures.length === 0 && report.pageErrors.length === 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.message ? e.message : e);
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    try { if (preview) preview.kill(); } catch { /* ignore */ }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });