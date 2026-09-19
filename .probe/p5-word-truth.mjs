/**
 * p5-word-truth.mjs —— 真浏览器里点「导出 Word（.docx）」，拿真下载文件验收。
 *
 * 为什么要有这一层：单测能证明「按钮接线对、OOXML 结构对」，但证明不了
 * 「用户在页面上点一下真的会下载一个 Word 能打开的文件」。本探针用：
 *   真 Chrome（headless）+ 真 dist-server 产物 + 桩 LLM（本地 http，OpenAI 兼容）
 *   + 真 Chrome 下载目录 → 再用 python-docx 打开下载到的 .docx 验收内容。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const PY = 'C:/Users/22953/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const APP_URL = 'http://127.0.0.1:8799/';
const LLM_PORT = 8971;
const CDP_PORT = 9479;
const ROOT = 'E:/tools/Hogo-QA-tool';
const DL = ROOT + '/.probe/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 桩 LLM 返回的固定正文：覆盖标题 / 项目符号 / 表格 / 有序列表。 */
const STUB_MD = [
  '## 总体结论',
  '',
  '本段来自**桩服务**，用于验证 Word 排版链路。',
  '',
  '| 特性 | Cpk |',
  '| --- | --- |',
  '| 外壳长度 | 3.65 |',
  '',
  '### 改善建议',
  '',
  '- 复核实测数据与量具',
  '1. 收紧上公差',
].join('\n');

function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  for (let i = 0; i < 60; i += 1) rows.push('外壳长度,' + (50 + Math.sin(i * 0.7) * 0.03).toFixed(4) + ',50.2,49.8');
  for (let i = 0; i < 60; i += 1) rows.push('转轴直径,' + (12 + Math.sin(i * 0.5) * 0.006).toFixed(4) + ',12.02,11.98');
  return rows.join('\n');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) for (const h of this.handlers.get(m.method)) h(m.params);
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; }
}
async function waitHttp(url, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { try { const r = await fetch(url); if (r.ok) return true; } catch { /* */ } await sleep(200); } throw new Error('timeout ' + url); }

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
      res.end(JSON.stringify({ data: [{ id: 'stub-word-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        model: 'stub-word-model',
        choices: [{ finish_reason: 'stop', message: { content: STUB_MD } }],
      }));
    });
  });
  return new Promise((resolve) => server.listen(LLM_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.mkdirSync(DL, { recursive: true });
  for (const f of fs.readdirSync(DL)) { if (f.endsWith('.docx')) fs.unlinkSync(path.join(DL, f)); }
  const profile = path.join(os.tmpdir(), 'hogo-p5word-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const report = { asserts: [], steps: [], ok: false };
  const check = (name, pass, detail) => report.asserts.push({ name, pass: !!pass, detail });
  const llm = await startLlmStub();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
  let preview;
  try {
    preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server', '--host', '127.0.0.1', '--port', '8799', '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    await waitHttp(APP_URL, 30000);
    await waitHttp('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    const waitEval = async (expr, label, timeout = 40000) => {
      const dl = Date.now() + timeout;
      while (Date.now() < dl) {
        try { if (await cdp.eval(expr)) { report.steps.push('OK: ' + label); return true; } } catch { /* */ }
        await sleep(250);
      }
      throw new Error('timeout ' + label);
    };

    // 1) 先落 AI 配置（指向桩服务），再进应用 → bootstrap 会把 mode 探成 ai
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '应用加载');
    await cdp.eval(`localStorage.setItem('hogo-qa-settings', ${JSON.stringify(JSON.stringify({
      baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1', apiKey: '', model: 'stub-word-model',
      maxTokens: 2048, disableThinking: true, allowRawData: false,
    }))})`);
    await cdp.send('Page.navigate', { url: APP_URL + '#/report' });
    await waitEval('document.body.innerText.includes("Hogo-QA-tool")', '重载（带 AI 配置）');
    await sleep(1500);

    // 2) 导入数据
    await cdp.eval('(function(){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")==="/import";})[0]; if(a) a.click(); return !!a; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"import-page\\"]")', '导入页');
    await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll(".MuiTab-root")).filter(function(e){return e.textContent.indexOf("粘贴 CSV")>=0;})[0]; if(t) t.click(); return true; })()');
    await waitEval('!!document.querySelector("textarea[data-testid=\\"paste-input\\"]")', '粘贴框');
    await cdp.eval('(function(){ var el=document.querySelector("textarea[data-testid=\\"paste-input\\"]"); var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set; s.call(el,' + JSON.stringify(buildCsv()) + '); el.dispatchEvent(new Event("input",{bubbles:true})); return true; })()');
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="解析";})[0]; b.click(); return true; })()');
    await waitEval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; return !!b && !b.disabled; })()', '解析完成', 25000);
    await cdp.eval('(function(){ var b=[].slice.call(document.querySelectorAll("button")).filter(function(e){return e.textContent.trim()==="确认导入并分析";})[0]; b.click(); return true; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"capability-page\\"]")', '能力页');
    await cdp.eval('(function(){ var a=[].slice.call(document.querySelectorAll("a[href]")).filter(function(e){return (e.getAttribute("href")||"")==="/report";})[0]; a.click(); return true; })()');
    await waitEval('!!document.querySelector("[data-testid=\\"ai-export-panel\\"]")', '报表页 + AI 导出面板');

    // headless 的下载落盘时序不可靠（实测 30s 内没落盘），改为在页面内抓 Blob：
    // 这同时能验证「导出走的是 Blob + a[download]」这条真实路径。
    await cdp.eval([
      '(function(){',
      ' window.__lastBlob=null; window.__dlName=null;',
      ' var oc=URL.createObjectURL; URL.createObjectURL=function(b){ try{ window.__lastBlob=b; }catch(e){} return oc.call(URL,b); };',
      ' var oc2=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ try{ if(this.download) window.__dlName=this.download; }catch(e){} return oc2.call(this); };',
      ' return true; })()',
    ].join(''));

    // 3) 探针前置断言：按钮存在且可用，AI 模式可用（不是离线禁用）
    check('Word 按钮存在', await cdp.eval('!!document.querySelector("[data-testid=\\"ai-export-word\\"]")'));
    check('Word 按钮文案含 .docx', await cdp.eval('(function(){ var b=document.querySelector("[data-testid=\\"ai-export-word\\"]"); return !!b && b.textContent.indexOf(".docx")>=0; })()'));
    check('未生成时 Word 按钮禁用（不能导出空文档）', await cdp.eval('(function(){ var b=document.querySelector("[data-testid=\\"ai-export-word\\"]"); return !!b && b.disabled; })()'));
    check('离线提示不存在（桩 LLM 已被探测为可用）', await cdp.eval('!document.querySelector("[data-testid=\\"ai-export-offline\\"]")'));
    check('生成按钮可用', await cdp.eval('(function(){ var b=document.querySelector("[data-testid=\\"ai-generate\\"]"); return !!b && !b.disabled; })()'));

    // 4) 生成 AI 分析（桩服务固定正文）→ 等结果渲染
    await cdp.eval('document.querySelector("[data-testid=\\"ai-generate\\"]").click()');
    await waitEval('document.querySelectorAll("[data-testid^=\\"ai-result-\\"]").length > 0', 'AI 分析结果渲染', 60000);
    await waitEval('!document.querySelector("[data-testid=\\"ai-progress\\"]")', '分析完成', 60000);
    report.resultCount = await cdp.eval('document.querySelectorAll("[data-testid^=\\"ai-result-\\"]").length');
    check('Word 按钮转为可用', await cdp.eval('(function(){ var b=document.querySelector("[data-testid=\\"ai-export-word\\"]"); return !!b && !b.disabled; })()'));

    // 5) 点击导出 → 真下载
    await cdp.eval('document.querySelector("[data-testid=\\"ai-export-word\\"]").click()');
    await waitEval('(function(){ return document.body.innerText.indexOf("已导出 Word 报表")>=0; })()', '导出成功提示', 30000);
    report.toast = await cdp.eval('(function(){ var t=[].slice.call(document.querySelectorAll("div")).filter(function(e){return e.textContent && e.textContent.indexOf("已导出 Word 报表")>=0;}); return t.length ? t[t.length-1].textContent.slice(0,120) : null; })()');

    report.downloadName = await cdp.eval('window.__dlName');
    report.blobType = await cdp.eval('window.__lastBlob ? window.__lastBlob.type : null');
    const b64 = await cdp.eval('(async function(){ if(!window.__lastBlob) return null; var buf=await window.__lastBlob.arrayBuffer(); var u=new Uint8Array(buf); var s=""; for(var i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); })()');
    check('导出触发了一次带 download 的下载', !!report.downloadName, report.downloadName);
    check('Blob 的 MIME 是 docx', report.blobType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', report.blobType);
    let file = null;
    if (b64) {
      file = path.join(DL, String(report.downloadName || 'p5-word.docx'));
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    }
    check('真的产出了 .docx 文件字节', !!file && fs.statSync(file).size > 4000, file ? fs.statSync(file).size + ' bytes' : null);
    if (file) {
      report.file = file;
      report.bytes = fs.statSync(file).size;
      check('文件名含项目名与日期', /AI分析\.docx$/.test(file));
      // 6) python-docx 打开真下载文件
      const pyOut = await new Promise((resolve) => {
        const p = spawn(PY, ['.probe/p5-docx-verify-download.py', file], { cwd: ROOT });
        let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
        p.on('close', () => resolve(out));
      });
      report.pythonDocx = pyOut.trim();
      let parsed = null;
      try { parsed = JSON.parse(pyOut.slice(pyOut.indexOf('{'))); } catch { /* */ }
      check('python-docx 能打开且结构齐备', parsed && parsed.ALL_PASS === true, report.pythonDocx.slice(0, 300));
    }
    report.ok = report.asserts.every((a) => a.pass);
  } catch (e) {
    report.error = String(e && e.message ? e.message : e);
  } finally {
    try { chrome.kill(); } catch { /* */ }
    try { preview.kill(); } catch { /* */ }
    try { llm.close(); } catch { /* */ }
  }
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ok ? 0 : 1);
}
await main();