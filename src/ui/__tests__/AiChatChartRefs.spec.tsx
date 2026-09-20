// @vitest-environment jsdom
/**
 * AI 回复里的「图表引用」（P8）。
 *
 * 用户指令：「同时可以引用或者生成图表来参考解释」。
 *
 * 证伪立场：
 *  - 删掉气泡里的 <ChatChartRefs> → 用例 1 变红；
 *  - 把渲染改成「按模型文字画图」而不是「按项目数据现算」→ 用例 2 变红
 *    （模型引用了一个不存在的特性，必须画不出图，绝不能凭空画一张）；
 *  - 复制时不剥离 [[chart:...]] 标记 → 用例 3 变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
import { useAiChatStore } from '@/store/aiChatStore';
import type { Dataset } from '@/data/schema';
import AiAssistantPage from '@/ui/pages/AiAssistantPage';
import { resolveChartRef } from '@/ui/components/ChatChartRefs';
import { defaultToggleConfig } from '@/core';

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
        measurements: Array.from({ length: 60 }, (_, i) => ({
          id: `m${i}`,
          characteristicId: 'c1',
          value: 50 + Math.sin(i) * 0.05,
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

/** 预置一条「AI 引用了图表」的回复。 */
function seedAssistantReply(text: string): void {
  useAiChatStore.setState({
    entries: [
      { id: 'u1', role: 'user', text: '帮我解释这批数据' },
      { id: 'a1', role: 'assistant', text, ok: true },
    ],
    question: '',
    allowRaw: false,
    loading: false,
  });
}

/**
 * resolveChartRef —— 「聊天里的图」与页面上那张图同口径。
 *
 * 这一组直接调解析函数（不经过 DOM）：断言的是**数据面**，
 * 比「画出来没有」更能抓住「口径不一致」这类缺陷。
 */
describe('resolveChartRef —— 图必须与「控制图 / 能力分析」页同口径', () => {
  const rules = defaultToggleConfig();

  it('按项目数据现算：60 个值 / 子组容量 5 → 12 个子组点', () => {
    const resolved = resolveChartRef('chart:control:外壳长度', makeDataset(), 5, rules);
    expect(resolved?.kind).toBe('control');
    if (resolved?.kind === 'control') {
      expect(resolved.series.primary.points).toHaveLength(12);
    }
  });

  it('被人工排除的异常值不进图（与页面上同一口径，不拿废弃数据画图）', () => {
    const dataset = makeDataset();
    dataset.characteristics[0].measurements = dataset.characteristics[0].measurements.map((m, i) =>
      i < 5 ? { ...m, excluded: true, excludeReason: '人工确认' } : m,
    );
    const resolved = resolveChartRef('chart:control:外壳长度', dataset, 5, rules);
    expect(resolved?.kind).toBe('control');
    if (resolved?.kind === 'control') {
      expect(resolved.series.primary.points).toHaveLength(11);
    }
  });

  it('没有有效测量值 / 无缺陷记录 / 不存在的特性 → 一律 null（不画空图）', () => {
    const dataset = makeDataset();
    dataset.characteristics[0].measurements = dataset.characteristics[0].measurements.map((m) => ({
      ...m,
      excluded: true,
      excludeReason: '人工确认',
    }));
    expect(resolveChartRef('chart:control:外壳长度', dataset, 5, rules)).toBeNull();
    expect(resolveChartRef('chart:histogram:外壳长度', dataset, 5, rules)).toBeNull();
    expect(resolveChartRef('chart:pareto:all', dataset, 5, rules)).toBeNull();
    expect(resolveChartRef('chart:control:不存在的特性', makeDataset(), 5, rules)).toBeNull();
  });
});
describe('AI 助手 —— 引用图表（P8）', () => {
  beforeEach(() => {
    useSettingsStore.getState().setMode('ai', '可用');
    useProjectStore.getState().setDataset(makeDataset());
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
    useAnalysisStore.getState().setSubgroupCapacity(5);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('回复里引用控制图 → 用项目真实数据渲染出控制图，且标记本身不出现在正文里', async () => {
    seedAssistantReply('结论：第 7 子组均值越上限。\n[[chart:control:外壳长度]]\n建议复核刀具。');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('ai-chart-refs')).toBeInTheDocument();
    });
    expect(screen.getByTestId('control-chart')).toBeInTheDocument();
    // 正文里不能露出程序用的标记
    expect(screen.queryByText(/\[\[chart:/)).not.toBeInTheDocument();
    expect(screen.getByText(/第 7 子组均值越上限/)).toBeInTheDocument();
  });

  it('引用直方图 → 渲染直方图组件（同样是现算的真图）', async () => {
    seedAssistantReply('分布见下图。\n[[chart:histogram:外壳长度]]');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('histogram-chart')).toBeInTheDocument();
    });
  });

  it('模型自造/引用了不存在的图表 id → 不渲染任何图（绝不凭空画图）', () => {
    seedAssistantReply('见下图。\n[[chart:control:不存在的特性]]\n[[chart:pareto:all]]');
    renderPage();

    expect(screen.queryByTestId('ai-chart-refs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('control-chart')).not.toBeInTheDocument();
  });

  it('「复制对话」同样剥离标记（整段粘出去也不带内部标记）', async () => {
    seedAssistantReply('结论：过程受控。\n[[chart:control:外壳长度]]');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();
    fireEvent.click(screen.getByTestId('ai-copy-transcript'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('我：帮我解释这批数据\n\nAI 助手：结论：过程受控。');
    });
  });
  it('复制这条消息时拷的是剥离标记后的正文（用户粘出去不带内部标记）', async () => {
    seedAssistantReply('结论：过程受控。\n[[chart:control:外壳长度]]');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();
    fireEvent.click(screen.getByTestId('ai-copy-a1'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('结论：过程受控。');
    });
  });
});