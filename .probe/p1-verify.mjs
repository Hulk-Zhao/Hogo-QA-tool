/**
 * p1-verify.mjs —— 第六轮 P1 真实浏览器验收（真 Chrome + 真 IndexedDB + 真 Ollama）。
 *
 * 验证四件事（全部在**真实产物**上跑，不接受「构建成功 = 功能可用」）：
 *   P1-A 保存 → 刷新 → 数据自动恢复（报表页不再是「尚无可导出的数据」空态）
 *   P1-B AI 审计：真实 AI 调用后落盘，刷新后设置页审计表仍在
 *   P1-C 原型污染防护：离线包产物里确实含拦截告警文案（防止守卫漏进 bundle）
 *   P1-D 「清除已保存的 AI 配置」：真点击后 hogo-qa-settings 整键消失
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9451;
const OUT = 'E:/tools/Hogo-QA-tool/.probe/p1-verify-result.json';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';
const PREFERRED_MODELS = ['qwen3.5:9b', 'qwen2.5:14b-max', 'qwen2.5-coder:7b-instruct-q4_K_M'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 60 个正常值 + 1 个显著离群值（驱动「异常值确认 → 保存」这条真实保存路径）。 */
function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) {
    rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
  }
  rows.push('外壳长度,50.9000,50.2,49.8');
  return rows.join('\n');
}
const CSV = buildCsv();

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    }
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        try {
          return await r.json();
        } catch {
          return null;
        }
      }
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('等待超时：' + url);
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p1-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  const report = { steps: [], checks: {}, pageErrors: [], consoleErrors: [] };
  let preview;
  try {
    preview = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server',
      '--host', '127.0.0.1', '--port', '8787', '--strictPort',
    ], { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    await waitForHttp(APP_URL, 30000);
    report.steps.push('OK: vite preview 8787 (dist-server)');

    const tags = await waitForHttp('http://127.0.0.1:11434/api/tags', 15000);
    const names = (tags && tags.models ? tags.models : []).map((m) => m.name);
    const MODEL = PREFERRED_MODELS.find((n) => names.includes(n)) || names[0];
    if (!MODEL) throw new Error('本机 Ollama 无可用模型');
    report.steps.push('OK: real Ollama，模型=' + MODEL);

    await waitForHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => report.pageErrors.push(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) ||
        JSON.stringify(p.exceptionDetails)));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        report.consoleErrors.push(p.args.map((a) => a.value || a.description || '').join(' '));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false,
    });

    const waitEval = async (expr, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await cdp.eval(expr)) {
            report.steps.push('OK: ' + label);
            return true;
          }
        } catch {
          /* retry */
        }
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    };
    const spaNav = async (route, predicate, label) => {
      const clicked = await cdp.eval(
        '(function(h){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")===h;})[0]; if(!a) return false; a.click(); return true; })(' +
          JSON.stringify(route) + ')');
      if (!clicked) throw new Error('未找到导航: ' + route);
      await waitEval(predicate, label);
    };
    const setInput = async (label, value) => {
      const ok = await cdp.eval(
        '(function(l,v){ var el=[].slice.call(document.querySelectorAll("input")).filter(function(e){return e.getAttribute("aria-label")===l;})[0]; if(!el) return false; var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set; s.call(el,v); el.dispatchEvent(new Event("input",{bubbles:true})); return true; })(' +
          JSON.stringify(label) + ',' + JSON.stringify(value) + ')');
      if (!ok) throw new Error('未找到输入框: ' + label);
      await sleep(400);
    };
    const clickTestId = async (testid) => {
      const ok = await cdp.eval(
        '(function(t){ var b=document.querySelector("[data-testid=\\"" + t + "\\"]"); if(!b) return false; b.click(); return true; })(' +
          JSON.stringify(testid) + ')');
      if (!ok) throw new Error('未找到元素: ' + testid);
    };

    // ================= 启动：导入 CSV（含 1 个离群值） =================
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await spaNav('/import', '!!document.querySelector("[data-testid=\\"import-page\\"]")', '导入页');
    await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\\"paste-input\\"]")', '粘贴框');
    await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(CSV) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return el.value.length; })()');
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
    await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
    await waitEval('document.body.innerText.indexOf("Cpk")>=0', '导入完成', 25000);

    // ================= P1-A 写入侧：真实保存路径（异常值确认 → persist） =================
    await spaNav('/capability', '!!document.querySelector("[data-testid=\\"outlier-card\\"]")', '能力页');
    await waitEval('!!document.querySelector("[data-testid=\\"apply-exclusions\\"]")', '检测到离群值（候选存在）', 20000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="全选";})[0]; if(!b) return false; b.click(); return true; })()');
    await waitEval('(function(){ var b=document.querySelector("[data-testid=\\"apply-exclusions\\"]"); return !!b && !b.disabled; })()', '确认按钮可用');
    await clickTestId('apply-exclusions');
    await waitEval('(function(){ try { return !!JSON.parse(localStorage.getItem("hogo-qa-last-project")||"null"); } catch(e) { return false; } })()', 'P1-A: 保存成功后写入「上次项目」记录', 25000);
    report.checks.lastProjectRecord = await cdp.eval('localStorage.getItem("hogo-qa-last-project")');
    report.checks.projectsInIdb = await cdp.eval(
      '(async function(){ var db=await new Promise(function(res,rej){ var r=indexedDB.open("hogo-qa-tool",1); r.onsuccess=function(){res(r.result);}; r.onerror=function(){rej(r.error);}; }); var keys=await new Promise(function(res,rej){ var tx=db.transaction("projects","readonly"); var rq=tx.objectStore("projects").getAllKeys(); rq.onsuccess=function(){res(rq.result);}; rq.onerror=function(){rej(rq.error);}; }); return JSON.stringify(keys); })()');

    // ================= P1-A 读取侧：刷新（模拟用户按 F5） =================
    await cdp.eval('window.__p1marker = 1');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitEval('typeof window.__p1marker === "undefined"', '页面已真正重载（内存归零）', 30000);
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '重载后应用加载');
    // 刷新后**不做任何手动操作**：数据集应由 bootstrapProjectSession 自动恢复
    await waitEval('document.body.innerText.includes("外壳长度")', 'P1-A: 刷新后数据集自动恢复（无需手动开项目库）', 30000);
    report.checks.reportEmptyStateAfterReload = await cdp.eval('document.body.innerText.indexOf("尚无可导出的数据")>=0');
    await spaNav('/report', '!!document.querySelector("[data-testid=\\"report-export-options\\"]")', '报表页');
    await sleep(1500);
    report.checks.exportOptionCount = await cdp.eval('document.querySelectorAll("[data-testid^=\\"export-option-\\"]").length');
    report.checks.canvasCount = await cdp.eval('document.querySelectorAll("canvas").length');
    report.checks.reportShowsData = await cdp.eval('document.body.innerText.indexOf("外壳长度")>=0');
    report.checks.reportHasDataTable = await cdp.eval(
      '(function(){ var t=document.querySelectorAll("table"); if(t.length===0) return 0; return t[0].querySelectorAll("tbody tr").length; })()');
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('E:/tools/Hogo-QA-tool/.probe/p1-restored-report.png', Buffer.from(shot1.data, 'base64'));

    // ================= P1-B：真实 AI 调用 → 审计落盘 → 刷新后仍在 =================
    await spaNav('/settings', '!!document.querySelector("[data-testid=\\"settings-page\\"]")', '设置页');
    await setInput('Base URL', OLLAMA_URL);
    await setInput('模型名', MODEL);
    await setInput('API Key', '');
    await sleep(2000);
    report.checks.modeChip = await cdp.eval('(function(){ var c=document.querySelector("[data-testid=\\"settings-mode-chip\\"]"); return c? c.textContent : null; })()');
    await spaNav('/ai', '!!document.querySelector("[data-testid=\\"ai-assistant-page\\"]") || !!document.querySelector("[data-testid=\\"ai-assistant-offline\\"]")', 'AI 页');
    await waitEval('(function(){ var b=document.querySelector("[data-testid=\\"ai-action-capExplain\\"]"); return !!b && !b.disabled; })()', 'P1-B: AI 动作可点击', 25000);
    await clickTestId('ai-action-capExplain');
    await waitEval('(function(){ try { var l=JSON.parse(localStorage.getItem("hogo-qa-ai-usage-logs")||"[]"); return l.length>0; } catch(e) { return false; } })()', 'P1-B: AI 调用后审计记录落盘', 90000);
    report.checks.usageLogAfterCall = await cdp.eval('localStorage.getItem("hogo-qa-ai-usage-logs")');
    report.checks.usageLogInStore = await cdp.eval('(function(){ var t=document.querySelector("[data-testid=\\"usage-log-table\\"]"); return t? t.innerText.slice(0,200) : null; })()');

    await cdp.eval('window.__p1marker2 = 1');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitEval('typeof window.__p1marker2 === "undefined"', '第二次重载（审计读取侧）', 30000);
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '重载后应用加载（2）');
    await spaNav('/settings', '!!document.querySelector("[data-testid=\\"settings-page\\"]")', '设置页（2）');
    await waitEval('!!document.querySelector("[data-testid=\\"usage-log-table\\"]")', 'P1-B: 刷新后审计表仍在（此前为空表）', 20000);
    report.checks.usageLogTableAfterReload = await cdp.eval('document.querySelector("[data-testid=\\"usage-log-table\\"]").innerText.slice(0,200)');
    report.checks.usageLogEmptyAfterReload = await cdp.eval('!!document.querySelector("[data-testid=\\"usage-log-empty\\"]")');

    // ================= P1-D：清除已保存的 AI 配置 =================
    report.checks.settingsKeyBeforeClear = await cdp.eval('localStorage.getItem("hogo-qa-settings") !== null');
    await clickTestId('clear-ai-config');
    await waitEval('localStorage.getItem("hogo-qa-settings") === null', 'P1-D: 整键被删除（不是字段写空）', 15000);
    report.checks.settingsKeyAfterClear = await cdp.eval('localStorage.getItem("hogo-qa-settings") === null');
    report.checks.clearResultText = await cdp.eval('(function(){ var e=document.querySelector("[data-testid=\\"clear-ai-config-result\\"]"); return e? e.textContent : null; })()');
    report.checks.apiKeyFieldAfterClear = await cdp.eval('(function(){ var el=[].slice.call(document.querySelectorAll("input")).filter(function(e){return e.getAttribute("aria-label")==="API Key";})[0]; return el? el.value : null; })()');

    // ================= P1-C：防护进入离线产物 =================
    const offline = fs.readFileSync('E:/tools/Hogo-QA-tool/dist/index.html', 'utf8');
    report.checks.offlineBundleHasPrototypeGuard = offline.indexOf('尝试污染全局对象原型') >= 0;
    report.checks.offlineBundleBytes = Buffer.byteLength(offline);

    report.checks.pageErrors = report.pageErrors.length;
    report.checks.consoleErrors = report.consoleErrors.length;
    report.ok = true;
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
main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});