/**
 * p0-verify.mjs —— 第五轮 P0 修复的**真实浏览器 + 真实打印**验收（非 jsdom）。
 *
 * 为什么必须走这一层：本项目已两次被 jsdom 的假绿灯坑过（离线包白屏、replaceState），
 * 铁律是「产物必须在目标环境实测」。本脚本用真实 Chrome + CDP 验证四件事：
 *
 *   P0-1 报表内嵌图表：报表页 DOM 里真的有三张图（旧版一张都没有），
 *        且 `Page.printToPDF` 产物里**真的含位图对象**（打印预览有图 = 用户诉求）。
 *   P0-2 导出范围 7 项 + 落盘：勾选写进 settingsStore 并持久化，**整页 reload 后仍保持**。
 *   P0-4 判异开关落盘：设置页改开关后 reload 仍保持（用户「改完刷新就丢」的缺陷）。
 *   P0-3 AI 全面诊断：点一次按钮 → 真实请求 → 报告卡渲染 → reload 后报告仍在。
 *
 * 约束：真实 Chrome；--no-proxy-server 绕过本机代理；不依赖 any 第三方包（Node 内建 WebSocket）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Users/22953/AppData/Local/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://127.0.0.1:8787/';
const CDP_PORT = 9444;
const MOCK_LOG = 'E:/tools/Hogo-QA-tool/.probe/captured-requests.jsonl';
const OUT = 'E:/tools/Hogo-QA-tool/.probe/p0-verify-result.json';
const XLSX_SAMPLE = 'E:/tools/Hogo-QA-tool/.probe/p0-sample.xlsx';
const PDF_OUT = 'E:/tools/Hogo-QA-tool/.probe/report-print.pdf';
const PDF_OUT2 = 'E:/tools/Hogo-QA-tool/.probe/report-print-xlsx.pdf';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造两特性 CSV（含规格限），保证控制图/能力图都有数据。 */
function buildCsv() {
  const rows = ['物料名称,测量值,USL,LSL'];
  const push = (name, base, usl, lsl, amp) => {
    for (let i = 0; i < 60; i += 1) {
      const v = (base + Math.sin(i * 0.7) * amp + (i % 5) * 0.003).toFixed(4);
      rows.push(`${name},${v},${usl},${lsl}`);
    }
  };
  push('外壳长度', 50.0, 50.2, 49.8, 0.03);
  push('转轴直径', 12.0, 12.02, 11.98, 0.006);
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
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
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
      throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result.value;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        try {
          return await res.json();
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

/** 统计 PDF 内的位图对象数量（画布会被打印成位图 XObject）。 */
function countPdfImages(buffer) {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Subtype\s*\/Image/g);
  return matches ? matches.length : 0;
}

async function main() {
  const profile = path.join(os.tmpdir(), 'hogo-p0-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = { appUrl: APP_URL, steps: [], checks: {}, pageErrors: [], consoleErrors: [] };

  // 自管服务生命周期：本机策略禁止外部后台常驻进程，故由本脚本拉起并在 finally 回收。
  const servers = [];
  const startServer = async (args, url, label) => {
    const proc = spawn(process.execPath, args, { cwd: 'E:/tools/Hogo-QA-tool', stdio: 'ignore' });
    servers.push(proc);
    await waitForHttp(url, 30000);
    report.steps.push('OK: 服务就绪 ' + label);
  };
  await startServer(
    ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-server', '--host', '127.0.0.1', '--port', '8787', '--strictPort'],
    'http://127.0.0.1:8787/',
    'vite preview 8787',
  );
  await startServer(
    ['.probe/mock-ai-server.mjs'],
    'http://127.0.0.1:8899/v1/models',
    'mock-ai-server 8899',
  );

  try {
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20000);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    cdp.on('Runtime.exceptionThrown', (p) => {
      report.pageErrors.push(
        p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails),
      );
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        report.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const waitEval = async (expr, label, timeout = 25000) => {
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

    const spaNav = async (href, predicate, label, timeout = 25000) => {
      const clicked = await cdp.eval(
        `(() => { const a=[...document.querySelectorAll('a[href="${href}"]')][0]; if(!a) return false; a.click(); return true; })()`,
      );
      if (!clicked) throw new Error('未找到侧栏导航链接: ' + href);
      await waitEval(predicate, label, timeout);
    };

    await cdp.send('Page.navigate', { url: APP_URL });
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", '应用加载');
    report.steps.push('URL=' + (await cdp.eval('location.href')));

    // ------------------------------------------------------------------
    // 0) 导入数据（真实解析 + 真实建模）
    // ------------------------------------------------------------------
    const importCsv = async () => {
    await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '数据导入页');
    await cdp.eval(
      "(() => { const t=[...document.querySelectorAll('.MuiTab-root')].find(e=>e.textContent.includes('粘贴 CSV')); if(!t) return false; t.click(); return true; })()",
    );
    await waitEval("!!document.querySelector('textarea[data-testid=\"paste-input\"]')", '粘贴输入框');
    await cdp.eval(
      `(() => { const el=document.querySelector('textarea[data-testid="paste-input"]'); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(el, ${JSON.stringify(CSV)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length; })()`,
    );
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='解析'); b.click(); return true; })()",
    );
    await waitEval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()",
      '确认导入可点击',
      20000,
    );
    await cdp.eval(
      "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()",
    );
    await waitEval(
      "location.pathname==='/capability' || document.body.innerText.includes('Cpk')",
      '导入后到达能力分析页',
      20000,
    );
    };

    /** 走真实 xlsx 文件路径（含不良 sheet），让柏拉图也有真实数据可画。 */
    const importXlsx = async () => {
      await spaNav('/import', "!!document.querySelector('[data-testid=\"import-page\"]')", '数据导入页（xlsx）');
      await waitEval("!!document.querySelector('input[type=file]')", '文件输入控件就绪');
      await cdp.send('DOM.enable');
      const doc = await cdp.send('DOM.getDocument', { depth: -1 });
      const found = await cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type=file]',
      });
      if (!found.nodeId) throw new Error('未找到 input[type=file]');
      await cdp.send('DOM.setFileInputFiles', { files: [XLSX_SAMPLE], nodeId: found.nodeId });
      await waitEval(
        "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); return !!b && !b.disabled; })()",
        'xlsx 解析完成（确认导入可点）',
        30000,
      );
      await cdp.eval(
        "(() => { const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入并分析'); b.click(); return true; })()",
      );
      await waitEval(
        "location.pathname==='/capability' || document.body.innerText.includes('Cpk')",
        'xlsx 导入后到达能力分析页',
        20000,
      );
    };

    await importCsv();
    report.checks.imported = true;

    // ------------------------------------------------------------------
    // 1) P0-4：判异开关落盘（设置页关闭 W1 → reload → 仍为关闭）
    // ------------------------------------------------------------------
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", '设置页');
    const w1Before = await cdp.eval(
      "(() => { const el=document.querySelector('input[aria-label=\"W1 1点超3σ\"]'); return el ? el.checked : null; })()",
    );
    await cdp.eval("document.querySelector('input[aria-label=\"W1 1点超3σ\"]').click()");
    const w1AfterClick = await cdp.eval(
      "document.querySelector('input[aria-label=\"W1 1点超3σ\"]').checked",
    );
    const storedAfterClick = await cdp.eval(
      "localStorage.getItem('hogo-qa-preferences')",
    );
    report.checks.ruleW1 = { before: w1Before, afterClick: w1AfterClick, persistedRaw: storedAfterClick };

    // ------------------------------------------------------------------
    // 2) P0-1 / P0-2：报表页图表 + 7 项勾选
    // ------------------------------------------------------------------
    await spaNav('/report', "!!document.querySelector('[data-testid=\"report-page\"]')", '报表页');
    await waitEval("!!document.querySelector('[data-testid=\"report-charts\"]')", '图表区出现');
    report.checks.reportInitial = await cdp.eval(`(() => ({
      checkboxCount: document.querySelectorAll('[data-testid^="export-option-"]').length,
      hasControlChart: !!document.querySelector('[data-testid="control-chart"]'),
      hasHistogramChart: !!document.querySelector('[data-testid="histogram-chart"]'),
      hasParetoChart: !!document.querySelector('[data-testid="pareto-chart"]'),
      hasCpkTable: !!document.querySelector('[data-testid="report-cpk-table"]'),
      hasDefectTable: !!document.querySelector('[data-testid="report-defect-table"]'),
      hasRawDimTable: !!document.querySelector('[data-testid="report-raw-dimensions-table"]'),
      canvasCount: document.querySelectorAll('[data-testid="report-charts"] canvas').length,
    }))()`);

    // 「图表真的画出了数据」的可证伪判据。
    // 教训：最初只用「PDF 里 /Subtype /Image 计数」当作「有图」的证据，这是**坏代理**——
    // ECharts 画布哪怕只画了坐标轴、没有数据系列，照样会被 Chrome 光栅化成位图对象。
    // 改用「强饱和像素数」：数据系列是蓝色柱子/红色折线，饱和度高；
    // 而只有坐标轴/网格线时（ECharts 默认轴色 #6E7079）饱和像素≈0。
    await sleep(1200); // 等首帧稳定（图表已改为 animation:false，这里只是兜底）
    report.checks.chartColorInk = await cdp.eval(`(() => {
      const res = [];
      for (const cv of document.querySelectorAll('[data-testid="report-charts"] canvas')) {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let colored = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (d[i + 3] > 40 && mx - mn > 45 && mx > 70) colored += 1;
        }
        res.push(colored);
      }
      return res;
    })()`);
    report.checks.chartColorInkOk = report.checks.chartColorInk.every((n) => n > 500);

    // ------------------------------------------------------------------
    // 3) 真实打印：Page.printToPDF 产物必须含位图（= 打印预览真的有图）
    // ------------------------------------------------------------------
    const pdf = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pdfBuffer = Buffer.from(pdf.data, 'base64');
    fs.writeFileSync(PDF_OUT, pdfBuffer);
    report.checks.printPdf = {
      bytes: pdfBuffer.length,
      imageObjects: countPdfImages(pdfBuffer),
      path: PDF_OUT,
    };

    // ------------------------------------------------------------------
    // 4) P0-2：取消勾选控制图 → 立即消失；整页 reload → 仍保持（落盘）
    // ------------------------------------------------------------------
    await cdp.eval(
      "document.querySelector('[data-testid=\"export-option-controlChartImage\"] input').click()",
    );
    await waitEval("!document.querySelector('[data-testid=\"control-chart\"]')", '取消勾选后控制图消失');
    report.checks.afterUncheck = await cdp.eval(`(() => ({
      controlChecked: document.querySelector('[data-testid="export-option-controlChartImage"] input').checked,
      hasControlChart: !!document.querySelector('[data-testid="control-chart"]'),
      hasHistogramChart: !!document.querySelector('[data-testid="histogram-chart"]'),
    }))()`);

    await cdp.send('Page.reload', { ignoreCache: true });
    // reload 后内存态清空：项目数据本身**不会**自动恢复（项目库/自动恢复仍是 P1，见 memory 记录），
    // 因此这里改用真实 xlsx 重新导入，再断言「已落盘的导出范围」在重导入后的报表里依然生效。
    await waitEval("document.body.innerText.includes('Hogo-QA-tool')", 'reload 后应用外壳可用');
    await importXlsx();
    await spaNav('/report', "!!document.querySelector('[data-testid=\"report-page\"]')", 'reload+重导入后报表页');
    await waitEval("!!document.querySelector('[data-testid=\"report-charts\"]')", 'reload 后图表区仍在');
    report.checks.afterReload = await cdp.eval(`(() => ({
      controlChecked: document.querySelector('[data-testid="export-option-controlChartImage"] input').checked,
      hasControlChart: !!document.querySelector('[data-testid="control-chart"]'),
      hasHistogramChart: !!document.querySelector('[data-testid="histogram-chart"]'),
      hasParetoChart: !!document.querySelector('[data-testid="pareto-chart"]'),
      canvasCount: document.querySelectorAll('[data-testid="report-charts"] canvas').length,
      paretoHint: document.body.innerText.includes('无不良记录'),
      rawDimRows: document.querySelectorAll('[data-testid="report-raw-dimensions-table"] tbody tr').length,
    }))()`);

    // 真实打印（含不良数据的 xlsx 数据集）：剩余图表仍必须落进位图。
    const pdf2 = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    const pdf2Buffer = Buffer.from(pdf2.data, 'base64');
    fs.writeFileSync(PDF_OUT2, pdf2Buffer);
    report.checks.printPdfWithDefects = {
      bytes: pdf2Buffer.length,
      imageObjects: countPdfImages(pdf2Buffer),
      path: PDF_OUT2,
    };

    // reload 后设置页的判异开关也必须保持关闭（P0-4 的最终验收）。
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", 'reload 后设置页');
    report.checks.ruleW1.afterReload = await cdp.eval(
      "document.querySelector('input[aria-label=\"W1 1点超3σ\"]').checked",
    );

    // ------------------------------------------------------------------
    // 5) P0-3：AI 全面诊断（走本地模拟 OpenAI 服务端）
    // ------------------------------------------------------------------
    const setInput = (aria, val) =>
      cdp.eval(
        `(() => { const el=document.querySelector('input[aria-label=${JSON.stringify(aria)}]'); if(!el) return false; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`,
      );
    await setInput('Base URL', 'http://127.0.0.1:8899/v1');
    await setInput('模型名', 'qwen3.5:9b');
    await setInput('API Key', '');
    await waitEval(
      "(() => { const c=document.querySelector('[data-testid=\"settings-mode-chip\"]'); return !!c && c.textContent.includes('AI 模式'); })()",
      '进入 AI 模式（模拟服务端可达）',
      30000,
    );

    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'AI 助手页');
    await waitEval(
      "(() => { const b=document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]'); return !!b && !b.disabled; })()",
      '「AI 全面诊断」可点击',
      20000,
    );
    await cdp.eval("document.querySelector('[data-testid=\"ai-action-fullDiagnosis\"]').click()");
    await waitEval("!!document.querySelector('[data-testid=\"ai-full-diagnosis\"]')", '诊断报告卡渲染', 30000);
    const diagBeforeReload = await cdp.eval(
      "document.querySelector('[data-testid=\"diagnosis-content\"]').textContent.slice(0, 120)",
    );

    // 审计表接线（须在 reload 之前查）：AI 请求后设置页应出现「全面诊断」一行。
    // 注意：审计记录随内存态，整页 reload 后必为空 —— 项目数据不自恢复是已知 P1。
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", '设置页看审计（reload 前）');
    report.checks.diagnosis = {
      usageLogTableBeforeReload: await cdp.eval(
        "(() => { const t=document.querySelector('[data-testid=\"usage-log-table\"]'); return t ? { found: true, hasFullDiagnosis: t.innerText.includes('全面诊断'), text: t.innerText.slice(0, 160) } : { found: false }; })()",
      ),
      usageLogEmptyBeforeReload: await cdp.eval(
        "!!document.querySelector('[data-testid=\"usage-log-empty\"]')",
      ),
    };
    await spaNav('/ai', "!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", '回到 AI 助手页');

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitEval("!!document.querySelector('[data-testid=\"ai-assistant-page\"]')", 'reload 后 AI 助手页');
    await waitEval(
      "!!document.querySelector('[data-testid=\"ai-full-diagnosis\"]')",
      'reload 后诊断报告仍在（持久化）',
      20000,
    );
    report.checks.diagnosis = {
      ...(report.checks.diagnosis ?? {}),
      contentBeforeReload: diagBeforeReload,
      contentAfterReload: await cdp.eval(
        "document.querySelector('[data-testid=\"diagnosis-content\"]').textContent.slice(0, 120)",
      ),
      usageLogRows: await cdp.eval(
        "location.pathname === '/settings' ? null : 'see-settings'",
      ),
    };

    // 审计日志：设置页表格应出现「全面诊断」一行。
    await spaNav('/settings', "!!document.querySelector('[data-testid=\"settings-page\"]')", '设置页看审计');
    report.checks.diagnosis.usageLogTableAfterReload = await cdp.eval(
      "(() => { const t=document.querySelector('[data-testid=\"usage-log-table\"]'); return t ? t.innerText.slice(0, 200) : null; })()",
    );

    // 捕获到的请求体里必须出现「AI 全面诊断」任务名（证明 FEATURE_LABEL 同步上线）。
    try {
      const captured = fs.readFileSync(MOCK_LOG, 'utf8');
      report.checks.diagnosisRequestSeen = captured.includes('AI 全面诊断');
      report.checks.capturedBytes = captured.length;
    } catch (e) {
      report.checks.diagnosisRequestSeen = 'ERROR: ' + String(e);
    }

    report.ok = true;
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    for (const s of servers) {
      try {
        s.kill();
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  fs.writeFileSync(
    OUT,
    JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }, null, 2),
    'utf8',
  );
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});