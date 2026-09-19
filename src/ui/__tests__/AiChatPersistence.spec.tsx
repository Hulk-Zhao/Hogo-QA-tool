// @vitest-environment jsdom
/**
 * AI 助手会话跨页保留（P3-B 用户报障回归）。
 *
 * 用户原话：「AI 助手每次问完问题切换侧边菜单栏，回来记录就消失了」。
 * 根因：entries 是 AiAssistantPage 组件内的 useState，路由切换会卸载组件，
 * state 随之销毁 —— 因此「切页」在测试里等价于 `unmount()` 之后重新 `render()`。
 *
 * 证伪立场（每条用例都必须能因为「退回 useState」而变红）：
 *  - 用例 1：卸载 → 重新挂载后，对话气泡与条数 chip 必须还在；
 *  - 用例 2：输入框内容与「允许发送原始数据」开关同样跨挂载存活；
 *  - 用例 3：卸载后（无任何组件挂载）store 里依然持有记录 —— 真源不在组件里；
 *  - 用例 4：新增的「清空对话」出口真的能把记录倒掉（避免只进不出）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useProjectStore } from '@/store/projectStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
import { useAiChatStore } from '@/store/aiChatStore';
import type { Dataset } from '@/data/schema';
import AiAssistantPage from '@/ui/pages/AiAssistantPage';

function renderPage(): ReturnType<typeof render> {
  return render(
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
        measurements: Array.from({ length: 30 }, (_, i) => ({
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

const REPLY = '控制图解读结论：过程受控。';

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (_url: string, _init?: { body?: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'qwen3.5:9b',
        choices: [{ finish_reason: 'stop', message: { content: REPLY } }],
      }),
      text: async () => JSON.stringify({
        model: 'qwen3.5:9b',
        choices: [{ finish_reason: 'stop', message: { content: REPLY } }],
      }),
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function prepare(): void {
  useSettingsStore.getState().setMode('ai', '可用');
  useSettingsStore.getState().setAiConfig({
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    model: 'qwen3.5:9b',
    maxTokens: 4096,
  });
  useProjectStore.getState().setDataset(makeDataset());
}

/** 点一次快捷指令，等对话里出现「用户提问 + AI 回复」两条。 */
async function askOnce(): Promise<void> {
  fireEvent.click(screen.getByTestId('ai-action-chartExplain'));
  await waitFor(() => {
    expect(screen.getByTestId('ai-conversation-count').textContent).toContain('共 2 条');
  });
}

describe('AiAssistantPage —— 对话记录跨页保留（P3-B）', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
    useProjectStore.getState().clearDataset();
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('卸载再挂载（= 切换侧边菜单栏再回来）后，对话记录与条数仍在', async () => {
    prepare();
    stubFetch();

    const first = renderPage();
    await askOnce();
    expect(screen.getByText(new RegExp(REPLY))).toBeInTheDocument();
    first.unmount();

    // 模拟「切到别的页面再回来」：全新挂载一个组件实例。
    renderPage();
    expect(screen.getByTestId('ai-conversation-count').textContent).toContain('共 2 条');
    expect(screen.getByText(new RegExp(REPLY))).toBeInTheDocument();
  });

  it('输入框内容与「允许发送原始数据」开关同样跨挂载存活', () => {
    prepare();

    const first = renderPage();
    fireEvent.change(screen.getByLabelText('数据问答输入'), {
      target: { value: '这批数据受控吗？' },
    });
    fireEvent.click(screen.getByLabelText('允许发送原始数据'));
    expect((screen.getByLabelText('允许发送原始数据') as HTMLInputElement).checked).toBe(true);
    first.unmount();

    renderPage();
    expect((screen.getByLabelText('数据问答输入') as HTMLInputElement).value).toBe('这批数据受控吗？');
    expect((screen.getByLabelText('允许发送原始数据') as HTMLInputElement).checked).toBe(true);
  });

  it('组件全部卸载后，记录仍活在 store 里（真源不在组件 state）', async () => {
    prepare();
    stubFetch();

    const first = renderPage();
    await askOnce();
    first.unmount();

    const entries = useAiChatStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('user');
    expect(entries[1].role).toBe('assistant');
  });

  it('「清空对话」按钮把记录倒掉并回到空态', async () => {
    prepare();
    stubFetch();

    renderPage();
    await askOnce();
    fireEvent.click(screen.getByTestId('ai-clear-chat'));

    expect(useAiChatStore.getState().entries).toEqual([]);
    expect(screen.queryByTestId('ai-conversation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-conversation-count')).not.toBeInTheDocument();
    expect(screen.getByText(/尚未发起 AI 请求/)).toBeInTheDocument();
  });
});
