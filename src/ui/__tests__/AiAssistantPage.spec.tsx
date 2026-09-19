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
