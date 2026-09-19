// @vitest-environment jsdom
/**
 * AiAssistantPage 测试（P0-23；T05 验收要点 3/4）。
 *
 * 覆盖：离线门控（置灰）、在线渲染、快捷指令、数据主权二次确认、
 * 发送范围 chip、Markdown 报告插入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useProjectStore } from '@/store/projectStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
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
      text: async () => '',
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
      text: async () => '',
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
        text: async () => '',
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
      text: async () => '',
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