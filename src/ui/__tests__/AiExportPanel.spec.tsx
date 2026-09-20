// @vitest-environment jsdom
/**
 * AiExportPanel 测试（P4-B）。
 *
 * 证伪立场：
 *  - 若离线时仍允许点「生成」→ 「离线禁用」变红；
 *  - 若不把勾选的方向传给执行器 → 「方向透传」变红；
 *  - 若不渲染逐模块结果 → 「结果按模块展示」变红；
 *  - 若导出 Excel 时忘传 aiRows → 「Excel 带上 AI 分析行」变红；
 *  - 若执行器抛错时静默 → 「错误可见」变红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import AiExportPanel from '@/ui/components/AiExportPanel';
import { useAiReportStore } from '@/store/aiReportStore';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import type { RunReportAnalysisResult } from '@/services/ai/reportAnalysis';
import type { ReportModel } from '@/data/exporter/reportModel';

const spies = vi.hoisted(() => ({ md: vi.fn(), excel: vi.fn(), word: vi.fn() }));

/** 图表采集器桩：让「Word 导出是否带上图表 PNG」可被断言。 */
const chartStub = vi.hoisted(() => ({
  name: '控制图（外壳长度）',
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  widthPx: 100,
  heightPx: 50,
}));

vi.mock('@/services/report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/report')>();
  return {
    ...actual,
    // 不让用例真的触发浏览器下载；换成记录入参的假实现。
    exportAiReportMarkdown: (...args: unknown[]) => {
      spies.md(...args);
      return '测试项目_2026-09-19_AI分析.md';
    },
    exportExcelReportDetailed: (...args: unknown[]) => {
      spies.excel(...args);
      return { fileName: '测试项目_2026-09-19.xlsx', imageCount: 2, aiModuleCount: 6 };
    },
    exportAiReportWord: (...args: unknown[]) => {
      spies.word(...args);
      return '测试项目_2026-09-19_AI分析.docx';
    },
    collectChartImages: () => [chartStub],
  };
});

function makeModel(): ReportModel {
  return {
    projectName: '测试项目',
    generatedAt: '2026-09-19T08:00:00.000Z',
    cpkSummary: [],
    defectStats: [],
    rawDimensions: [],
    rawDefects: [],
    warnings: [],
  };
}

function makeResult(): RunReportAnalysisResult {
  return {
    analyses: [
      {
        moduleId: 'cpk',
        title: 'CPK 汇总',
        markdown: '### CPK 汇总\n- 外壳长度 Cpk=1.1 低于 1.33',
        ok: true,
        model: 'qwen3.5:9b',
        errorMessage: null,
        skipReason: null,
        sentFields: ['moduleTitle'],
      },
      {
        moduleId: 'defect',
        title: '不良统计',
        markdown: '',
        ok: false,
        model: '',
        errorMessage: null,
        skipReason: '本次未导入不良记录，无法进行不良统计。',
        sentFields: [],
      },
    ],
    requestCount: 1,
    usage: [
      {
        id: 'u1',
        feature: 'moduleAnalysis',
        sentPayloadScope: 'summary',
        model: 'qwen3.5:9b',
        requestedAt: '2026-09-19T08:00:00.000Z',
        ok: true,
      },
    ],
    abortedBy: null,
  };
}

function renderPanel(runner: unknown): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={['/report']}>
        <AiExportPanel model={makeModel()} runner={runner as never} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  spies.md.mockClear();
  spies.excel.mockClear();
  spies.word.mockClear();
  useAiReportStore.getState().clear();
  useAiReportStore.setState({ focusIds: ['stability', 'capability', 'improvement'] });
  useUiStore.setState({ toasts: [] });
  useProjectStore.setState({ aiUsageLogs: [] });
  useSettingsStore.setState({
    mode: 'ai',
    modeReason: 'AI 服务可用。',
    aiConfig: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      maxTokens: 4096,
      disableThinking: true,
      allowRawData: false,
    },
  });
});

describe('AiExportPanel', () => {
  it('★ 离线 / 未配置：给出说明 + 去设置入口，且「生成 AI 分析」禁用', () => {
    useSettingsStore.setState({ mode: 'offline', modeReason: '未配置 Base URL，当前为离线模式。' });
    renderPanel(vi.fn());
    expect(screen.getByTestId('ai-export-offline')).toBeInTheDocument();
    expect(screen.getByText('未配置 Base URL，当前为离线模式。')).toBeInTheDocument();
    expect(screen.getByTestId('ai-generate')).toBeDisabled();
    expect(screen.getByTestId('ai-export-markdown')).toBeDisabled();
    expect(screen.getByTestId('ai-export-word')).toBeDisabled();
  });

  it('全部分析方向都在界面上可选（可选择分析方向）', () => {
    renderPanel(vi.fn());
    for (const id of ['stability', 'capability', 'defectPareto', 'riskWarning', 'improvement', 'delivery']) {
      expect(screen.getByTestId(`ai-focus-${id}`)).toBeInTheDocument();
    }
  });

  it('★ 生成：把勾选的方向与 AI 配置透传给执行器，并渲染逐模块结果', async () => {
    const runner = vi.fn(async (_req: unknown) => makeResult());
    renderPanel(runner);

    fireEvent.click(screen.getByTestId('ai-generate'));

    await waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    const req = runner.mock.calls[0][0] as {
      focusIds: string[];
      aiConfig: { baseUrl: string; model: string };
      maxTokens: number;
      disableThinking: boolean;
      model: ReportModel;
    };
    expect(req.focusIds).toEqual(['stability', 'capability', 'improvement']);
    expect(req.aiConfig).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' });
    expect(req.maxTokens).toBe(4096);
    expect(req.disableThinking).toBe(true);

    await screen.findByTestId('ai-result-cpk');
    expect(screen.getByTestId('ai-text-cpk').textContent).toContain('Cpk=1.1');
    // 失败模块的原因也要显示出来，不能静默
    expect(screen.getByTestId('ai-text-defect').textContent).toContain('未导入不良记录');
  });

  it('★ 生成后写审计（aiUsageLogs），并提示完成进度', async () => {
    const runner = vi.fn(async () => makeResult());
    renderPanel(runner);
    fireEvent.click(screen.getByTestId('ai-generate'));
    await waitFor(() => expect(useProjectStore.getState().aiUsageLogs).toHaveLength(1));
    expect(useProjectStore.getState().aiUsageLogs[0].feature).toBe('moduleAnalysis');
    const toasts = useUiStore.getState().toasts.map((t) => t.message);
    expect(toasts.some((m) => m.includes('AI 分析完成'))).toBe(true);
  });

  it('方向至少保留一条：取消到最后一个时不会变成空集', () => {
    useAiReportStore.setState({ focusIds: ['capability'] });
    renderPanel(vi.fn());
    fireEvent.click(screen.getByTestId('ai-focus-capability'));
    expect(useAiReportStore.getState().focusIds).toEqual(['capability']);
  });

  it('★ 导出 Markdown：带模型与方向元信息', async () => {
    const runner = vi.fn(async () => makeResult());
    renderPanel(runner);
    fireEvent.click(screen.getByTestId('ai-generate'));
    await screen.findByTestId('ai-result-cpk');

    fireEvent.click(screen.getByTestId('ai-export-markdown'));
    await waitFor(() => expect(spies.md).toHaveBeenCalledTimes(1));
    const [model, analyses, meta] = spies.md.mock.calls[0] as [ReportModel, unknown[], { model: string; focusIds: string[] }];
    expect(model.projectName).toBe('测试项目');
    expect(analyses).toHaveLength(2);
    expect(meta.model).toBe('qwen3.5:9b');
    expect(meta.focusIds).toEqual(['stability', 'capability', 'improvement']);
  });

  it('★ 导出 Excel：把 AI 分析行作为第 4 个参数传给导出器（否则 sheet 不会出现）', async () => {
    const runner = vi.fn(async () => makeResult());
    renderPanel(runner);
    fireEvent.click(screen.getByTestId('ai-generate'));
    await screen.findByTestId('ai-result-cpk');

    fireEvent.click(screen.getByTestId('ai-export-excel'));
    await waitFor(() => expect(spies.excel).toHaveBeenCalledTimes(1));
    const args = spies.excel.mock.calls[0] as unknown[];
    expect(args).toHaveLength(4);
    const aiRows = args[3] as { module: string; status: string }[];
    expect(aiRows).toEqual([
      { module: 'CPK 汇总', status: '已生成', model: 'qwen3.5:9b', analysis: '### CPK 汇总\n- 外壳长度 Cpk=1.1 低于 1.33' },
      { module: '不良统计', status: '未生成（本次未导入不良记录，无法进行不良统计。）', model: '', analysis: '' },
    ]);
  });

  it('★ 导出 Word：把同一份分析 + 元信息传给 docx 导出器，并提示文件名', async () => {
    const runner = vi.fn(async () => makeResult());
    renderPanel(runner);
    fireEvent.click(screen.getByTestId('ai-generate'));
    await screen.findByTestId('ai-result-cpk');

    fireEvent.click(screen.getByTestId('ai-export-word'));
    await waitFor(() => expect(spies.word).toHaveBeenCalledTimes(1));
    const args = spies.word.mock.calls[0] as [
      ReportModel,
      unknown[],
      { model: string; focusIds: string[] },
      unknown,
      { charts: unknown[] },
    ];
    expect(args).toHaveLength(5);
    const [model, analyses, meta] = args;
    expect(model.projectName).toBe('测试项目');
    expect(analyses).toHaveLength(2);
    expect(meta.model).toBe('qwen3.5:9b');
    expect(meta.focusIds).toEqual(['stability', 'capability', 'improvement']);
    // 第 4 参是保存函数（用例注入的是真 downloadBlob，这里只校验形状）
    expect(typeof args[3]).toBe('function');
    // 第 5 参必须带上图表 PNG：漏掉它就退回「只有文字、没有图片」
    expect(args[4]).toEqual({ charts: [chartStub] });
    const toasts = useUiStore.getState().toasts.map((t) => t.message);
    expect(toasts.some((m) => m.includes('已导出 Word 报表：测试项目_2026-09-19_AI分析.docx'))).toBe(true);
  });

  it('执行器抛错 → 可见的错误提示（不静默失败）', async () => {
    const runner = vi.fn(async () => {
      throw new Error('网络不可达');
    });
    renderPanel(runner);
    fireEvent.click(screen.getByTestId('ai-generate'));
    await screen.findByTestId('ai-run-error');
    expect(screen.getByTestId('ai-run-error').textContent).toContain('网络不可达');
    const toasts = useUiStore.getState().toasts.map((t) => t.message);
    expect(toasts.some((m) => m.includes('AI 分析失败：网络不可达'))).toBe(true);
  });

  it('数据变化后结果被标记为「对应旧数据」（防止把旧分析当新结论交付）', async () => {
    const runner = vi.fn(async () => makeResult());
    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AiExportPanel model={makeModel()} runner={runner as never} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByTestId('ai-generate'));
    await screen.findByTestId('ai-result-cpk');
    expect(screen.queryByTestId('ai-stale')).not.toBeInTheDocument();

    rerender(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AiExportPanel model={{ ...makeModel(), projectName: '换了项目' }} runner={runner as never} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('ai-stale')).toBeInTheDocument();
  });
});
