// @vitest-environment jsdom
/**
 * AiAssistantPage 测试（P0-23；T05 验收要点 3/4）。
 *
 * 覆盖：离线门控（置灰）、在线渲染、快捷指令、数据主权二次确认、
 * 发送范围 chip、Markdown 报告插入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useProjectStore } from '@/store/projectStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
import { useAiChatStore } from '@/store/aiChatStore';
import type { Dataset } from '@/data/schema';
import AiAssistantPage from '@/ui/pages/AiAssistantPage';

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AiAssistantPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function makeDataset(): Dataset {
  return {
    id: 'ds1',
    projectId: 'p1',
    name: '测试数据',
    sourceType: 'xlsx',
    importedAt: new Date().toISOString(),
    rawFileName: 'test.xlsx',
    characteristics: [
      {
        id: 'c1',
        datasetId: 'ds1',
        name: '外壳长度',
        specLimits: { usl: 50.3, lsl: 49.7, target: 50, unit: 'mm' },
        measurements: Array.from({ length: 50 }, (_, i) => ({
          id: `m${i}`,
          characteristicId: 'c1',
          value: 50 + Math.sin(i) * 0.1,
          subgroupId: null,
          timestamp: null,
          batch: null,
          excluded: false,
          excludeReason: null,
        })),
        subgroups: [],
        nullCount: 0,
        outlierFlags: [],
        preprocessConfigRef: null,
        measurementBlobRef: null,
      },
    ],
    defectRecords: [],
  };
}

describe('AiAssistantPage', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
    useProjectStore.getState().clearDataset();
    // 第五轮新增：诊断结果与审计日志均为跨用例共享的 store 状态，需显式归零。
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    // P3-B：会话记录迁到 aiChatStore（模块级单例），不再随组件卸载销毁，
    // 因此用例之间必须显式归零，否则上一条用例的气泡/loading 会污染下一条。
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('离线模式 → 显示离线提示，不渲染助手 UI', () => {
    renderPage();
    expect(screen.getByTestId('ai-assistant-offline')).toBeInTheDocument();
    expect(screen.getByTestId('ai-gate-disabled')).toBeInTheDocument();
    // 页面主体不渲染
    expect(screen.queryByTestId('ai-assistant-page')).not.toBeInTheDocument();
  });

  it('AI 模式 → 渲染页面与快捷指令', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    renderPage();
    expect(screen.getByTestId('ai-assistant-page')).toBeInTheDocument();
    expect(screen.getByTestId('ai-action-chartExplain')).toBeInTheDocument();
    expect(screen.getByTestId('ai-action-capExplain')).toBeInTheDocument();
    expect(screen.getByTestId('ai-action-suggest')).toBeInTheDocument();
    expect(screen.getByTestId('ai-action-report')).toBeInTheDocument();
  });

  it('点击「解读能力分析」→ 显示发送范围 chip 为「仅摘要」', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-capExplain'));
    await waitFor(() => {
      expect(screen.getByTestId('ai-scope-chip')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-scope-chip').textContent).toContain('仅摘要');
  });

  it('开启「允许发送原始数据」后点击 → 先弹出二次确认，且发送范围变为「摘要 + 明细」', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    renderPage();

    // 开启 switch
    const sw = screen.getByLabelText('允许发送原始数据');
    fireEvent.click(sw);

    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));

    // 二次确认对话框
    await waitFor(() => {
      expect(screen.getByText('确认发送原始明细数据')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('确认发送'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-scope-chip')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-scope-chip').textContent).toContain('明细');
  });

  it('无数据集 → 显示提示且快捷指令禁用', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    renderPage();
    expect(screen.getByText(/当前项目暂无数据/)).toBeInTheDocument();
    expect(screen.getByTestId('ai-action-chartExplain')).toBeDisabled();
  });

  it('点击「插入 Markdown 报告」→ 生成含标题的报告消息', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    // 构造 project 供报告生成
    useProjectStore.getState().setProject({
      id: 'p1',
      name: '测试项目',
      description: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
      datasets: [makeDataset()],
      analysisConfigs: [],
      aiUsageLogs: [],
    });
    renderPage();
    fireEvent.click(screen.getByText('插入 Markdown 报告'));
    await waitFor(() => {
      expect(screen.getByText(/# 质量分析报告/)).toBeInTheDocument();
    });
  });

  it('点击「解读当前控制图」→ 真的按 settingsStore.maxTokens 发起请求，且正文透出（接线 + D1 回归）', async () => {
    // 配置成「无 Key 的本地 Ollama」+ 自定义 maxTokens=8192。
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      maxTokens: 8192,
    });
    useProjectStore.getState().setDataset(makeDataset());

    const fetchMock = vi.fn(
      async (_url: string, _init?: { body?: string; headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'qwen3.5:9b',
        choices: [
          { finish_reason: 'stop', message: { content: '控制图解读结论：过程受控。' } },
        ],
      }),
      text: async () => JSON.stringify({
        model: 'qwen3.5:9b',
        choices: [
          { finish_reason: 'stop', message: { content: '控制图解读结论：过程受控。' } },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // 副作用断言：确实向 /chat/completions 发了 POST，且请求体携带配置的 maxTokens。
    const chatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/chat/completions'),
    ) as [string, { body: string; headers: Record<string, string> }] | undefined;
    expect(chatCall, '必须真的调用 chat/completions（而非仅内存改值）').toBeTruthy();
    const body = JSON.parse(chatCall![1].body);
    expect(body.max_tokens).toBe(8192);
    expect(body.model).toBe('qwen3.5:9b');
    // 空 Key 不得产生 Authorization 头（Ollama 无鉴权）。
    expect(chatCall![1].headers.Authorization).toBeUndefined();

    // 正文必须被渲染出来（非空结果透出 UI）。
    await waitFor(() => {
      expect(screen.getByText(/控制图解读结论/)).toBeInTheDocument();
    });
  });

  it('正文为空但返回推理内容 → 助手消息展示「思考过程」，不显示空白', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      maxTokens: 4096,
    });
    useProjectStore.getState().setDataset(makeDataset());

    const fetchMock = vi.fn(
      async (_url: string, _init?: { body?: string; headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning: '我正在逐步核对每一条判异准则……' },
          },
        ],
      }),
      text: async () => JSON.stringify({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning: '我正在逐步核对每一条判异准则……' },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));

    await waitFor(() => {
      expect(screen.getByText(/我正在逐步核对每一条判异准则/)).toBeInTheDocument();
    });
    // 断言来自 errorMessage 的「正文被截断」文案（而非页面里那句静态括号说明）。
    expect(screen.getByText(/正文被截断/)).toBeInTheDocument();
  });
});

/**
 * 第五轮 P0 修复 #12：AI 全面诊断（一键生成 + 导出 + 结果持久化）。
 *
 * 证伪立场：
 * - 若删掉 QUICK_ACTIONS 里的 fullDiagnosis 项 → 「按钮存在」用例变红；
 * - 若只在组件里 setState 而不写 diagnosisStore → 「写入 store / 预置记录即渲染」变红；
 * - 若丢掉 `appendAiUsageLog` → 「审计写入」用例变红（这正是设置页审计表永远为空的根因）。
 */
describe('AiAssistantPage —— AI 全面诊断（#12）', () => {
  // 本 describe 与上层 describe 平级，**不会**继承它的 beforeEach，必须自己归零，
  // 否则会读到上一个 describe 遗留的 dataset / 审计日志（曾因此出现「长度 3」假失败）。
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
    useProjectStore.getState().clearDataset();
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    // P3-B：会话记录迁到 aiChatStore（模块级单例），不再随组件卸载销毁，
    // 因此用例之间必须显式归零，否则上一条用例的气泡/loading 会污染下一条。
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
  });

  const DIAGNOSIS_TEXT = '## 一、总体结论\n过程整体受控，短板为转轴直径。';

  /** 让 chat/completions 返回一段诊断正文。 */
  function stubDiagnosisFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(
      async (_url: string, _init?: { body?: string }) => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-chat',
          choices: [{ finish_reason: 'stop', message: { content: DIAGNOSIS_TEXT } }],
        }),
        text: async () => JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ finish_reason: 'stop', message: { content: DIAGNOSIS_TEXT } }],
        }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('快捷指令里有「AI 全面诊断（一键）」按钮，且无数据时禁用', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    renderPage();
    const btn = screen.getByTestId('ai-action-fullDiagnosis');
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('点击后：请求体任务名为「AI 全面诊断」、结果写入 store 并渲染报告卡', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'deepseek-chat',
      maxTokens: 8192,
    });
    useProjectStore.getState().setDataset(makeDataset());
    const fetchMock = stubDiagnosisFetch();

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-fullDiagnosis'));

    // 1) 线上真的发出了一次请求，且任务名同步到位（FEATURE_LABEL 未漏配）。
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions')) as
      | [string, { body: string }]
      | undefined;
    expect(chatCall).toBeTruthy();
    expect(chatCall![1].body).toContain('AI 全面诊断');
    expect(chatCall![1].body).not.toContain('undefined');

    // 2) 结果写进持久化 store（而不是组件 state）。
    await waitFor(() => {
      expect(useDiagnosisStore.getState().fullDiagnosis).not.toBeNull();
    });
    expect(useDiagnosisStore.getState().fullDiagnosis?.content).toContain('过程整体受控');
    expect(useDiagnosisStore.getState().fullDiagnosis?.model).toBe('deepseek-chat');
    expect(useDiagnosisStore.getState().fullDiagnosis?.scope).toBe('summary');
    expect(useDiagnosisStore.getState().fullDiagnosis?.characteristicCount).toBe(1);

    // 3) 报告卡与导出入口渲染出来。
    expect(screen.getByTestId('ai-full-diagnosis')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-content').textContent).toContain('过程整体受控');
    expect(screen.getByTestId('diagnosis-export')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-model-chip').textContent).toContain('deepseek-chat');
  });

  it('已有持久化诊断 → 重新进入页面直接展示（不依赖上一次的组件 state）', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    // 模拟「上一次会话已保存报告，本次刷新后重新进入」。
    useDiagnosisStore.getState().setFullDiagnosis({
      id: 'diag-x',
      content: '# 上次会话保存的诊断',
      generatedAt: '2026-09-19T01:00:00.000Z',
      model: 'qwen3-max',
      scope: 'summary',
      sentFields: ['projectName'],
      projectName: '质量日报',
      characteristicCount: 2,
    });

    renderPage();

    expect(screen.getByTestId('ai-full-diagnosis')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-content').textContent).toContain('上次会话保存的诊断');
  });

  it('P9 补：报告正文里的 [[chart:…]] 引用不露标记，而是渲染成真图（与聊天气泡同口径）', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    useDiagnosisStore.getState().setFullDiagnosis({
      id: 'diag-z',
      content: '## 二、过程能力盘点\n\n[[chart:histogram:外壳长度]]\n\n均值 50.050643。',
      generatedAt: '2026-09-21T00:00:00.000Z',
      model: 'deepseek-flash',
      scope: 'summary',
      sentFields: ['projectName'],
      projectName: '质量日报',
      characteristicCount: 1,
    });

    renderPage();

    const content = screen.getByTestId('diagnosis-content');
    expect(content.textContent).toContain('均值 50.050643。');
    expect(content.textContent).not.toContain('[[chart:');
    // 引用被渲染成真图（数据现算，不是空 div）
    const refs = screen.getByTestId('ai-chart-refs');
    expect(refs.querySelector('[data-testid="histogram-chart"]')).not.toBeNull();
    // 整页都不该残留标记原文（复制 / 导出的入口同样不得露出）
    expect(document.body.textContent).not.toContain('[[chart:');
  });
  it('点击「清除」→ 报告卡消失且 store 归零', () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    useDiagnosisStore.getState().setFullDiagnosis({
      id: 'diag-y',
      content: '# 待清除',
      generatedAt: '2026-09-19T01:00:00.000Z',
      model: 'm',
      scope: 'summary',
      sentFields: [],
      projectName: 'p',
      characteristicCount: 1,
    });

    renderPage();
    fireEvent.click(screen.getByTestId('diagnosis-clear'));

    expect(useDiagnosisStore.getState().fullDiagnosis).toBeNull();
    expect(screen.queryByTestId('ai-full-diagnosis')).not.toBeInTheDocument();
  });

  it('每次请求都写入 AI 使用审计（设置页审计表不再永远为空）', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'deepseek-chat',
      maxTokens: 4096,
    });
    useProjectStore.getState().setDataset(makeDataset());
    stubDiagnosisFetch();

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-capExplain'));

    await waitFor(() => {
      expect(useProjectStore.getState().aiUsageLogs).toHaveLength(1);
    });
    const log = useProjectStore.getState().aiUsageLogs[0];
    expect(log.feature).toBe('capExplain');
    expect(log.sentPayloadScope).toBe('summary');
    expect(log.ok).toBe(true);
    expect(log.model).toBe('deepseek-chat');
    // 同时镜像进 project 实体（随项目落盘）。
    expect(useProjectStore.getState().project?.aiUsageLogs).toHaveLength(1);
  });

  it('请求失败时不把错误当成「诊断报告」持久化', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'deepseek-chat',
      maxTokens: 4096,
    });
    useProjectStore.getState().setDataset(makeDataset());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: '服务器内部错误' } }),
        text: async () => '服务器内部错误',
      })),
    );

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-fullDiagnosis'));

    await waitFor(() => {
      expect(useProjectStore.getState().aiUsageLogs).toHaveLength(1);
    });
    expect(useProjectStore.getState().aiUsageLogs[0].ok).toBe(false);
    expect(useDiagnosisStore.getState().fullDiagnosis).toBeNull();
    expect(screen.queryByTestId('ai-full-diagnosis')).not.toBeInTheDocument();
  });
});

/**
 * 用户报障回归（UI 面）：「HTTP 400 却看不出原因」。
 *
 * 证伪立场：
 * - 删掉气泡里的 `ai-server-detail` 渲染 → 用例 2 变红；
 * - 删掉 ChatEntry.serverDetail 的写入 → 用例 2 变红；
 * - 删掉 chatCompletion 的空模型名前置拦截 → 用例 1 变红（会真的发请求）。
 */
describe('AiAssistantPage —— 服务端错误原文可见（HTTP 400 报障回归）', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
    useProjectStore.getState().clearDataset();
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    // P3-B：会话记录迁到 aiChatStore（模块级单例），不再随组件卸载销毁，
    // 因此用例之间必须显式归零，否则上一条用例的气泡/loading 会污染下一条。
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
  });

  it('模型名为空 → 一个网络请求都不发，气泡直接点明「模型名」', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: '',
      maxTokens: 4096,
    });
    useProjectStore.getState().setDataset(makeDataset());

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));

    await waitFor(() => {
      expect(screen.getByText(/未配置「模型名」/)).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-server-detail')).not.toBeInTheDocument();
  });

  it('服务端 400 且带错误原文 → 气泡单独展示「服务端原文」（旧实现只给泛化文案）', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useSettingsStore.getState().setAiConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      maxTokens: 4096,
    });
    useProjectStore.getState().setDataset(makeDataset());

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'model is required' } }),
        text: async () => '{"error":{"message":"model is required"}}',
      })),
    );

    renderPage();
    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-server-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-server-detail').textContent).toContain('model is required');
    // 泛化文案仍在，但不再「只有」泛化文案。
    expect(screen.getByText(/请检查模型名与参数/)).toBeInTheDocument();
  });
});

  it('★ P9：等待时出现「停止」，点它真的中断请求（超时放宽到 120s 后不能只让人干等）', async () => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());

    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted === true) {
          fail();
          return;
        }
        init?.signal?.addEventListener('abort', fail);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    // 未提问时没有「停止」
    expect(screen.queryByTestId('ai-stop')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-action-chartExplain'));
    await waitFor(() => {
      expect(screen.getByTestId('ai-thinking')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-thinking').textContent).toContain('AI 思考中');
    expect(screen.getByTestId('ai-stop')).toBeInTheDocument();

    // 请求必须真的带上取消信号（否则「停止」只是个摆设）
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('ai-stop'));
    expect(capturedSignal?.aborted).toBe(true);

    // 取消后：等待态消失、气泡留下「请求已取消。」、不会走「自动重试」（取消不是故障）
    await waitFor(() => {
      expect(screen.queryByTestId('ai-thinking')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/请求已取消/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/chat/completions'))).toHaveLength(1);
  });

  it('★ P9：等待超过 1 秒后显示「已等待 1 秒」（慢回答不再像卡死）', async () => {
    vi.useFakeTimers();
    try {
      useSettingsStore.getState().setMode('ai', '可用');
      useProjectStore.getState().setDataset(makeDataset());
      // 永不返回的请求：模拟「模型很慢」，此时只有计时器在动。
      const fetchMock = vi.fn(async () => new Promise(() => undefined));
      vi.stubGlobal('fetch', fetchMock);

      renderPage();
      fireEvent.click(screen.getByTestId('ai-action-chartExplain'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.getByTestId('ai-thinking').textContent).toContain('已等待 1 秒');
    } finally {
      vi.useRealTimers();
    }
  });