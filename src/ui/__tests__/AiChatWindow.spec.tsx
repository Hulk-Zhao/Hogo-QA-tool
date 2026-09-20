// @vitest-environment jsdom
/**
 * AI 助手「微信式」对话视窗（P7）。
 *
 * 用户原话：「调整 AI 助手的问答展示方式，类似于微信的方式，点开是默认展示最底部消息，
 * 历史消息需要上拉，只保留对话且对话可以复制」。
 *
 * 四条行为逐条锁定（每条都能因为删掉对应实现而变红）：
 *  1. 进入页面（无论有没有历史消息）默认停在最底部；
 *  2. 用户上拉读历史时，新消息**不许**把视窗拽回底部；
 *  3. 用户自己滚回底部附近后，恢复跟随（阈值内也算）；
 *  4. 每条消息都能复制（我提的问题也能复制），并且能一键复制整段对话；
 *  5. 默认只保留对话：快捷指令 / 数据主权 / 诊断报告收在「+」面板里且默认收起。
 *
 * 关于 jsdom：它没有布局引擎，scrollHeight / clientHeight 恒为 0、也没有 scrollTo。
 * 因此这里给 HTMLElement.prototype 装一套「浏览器式」的假滚动实现（含钳制到最大值），
 * 让「贴底 / 上拉」变成可以确定性断言的数值，而不是靠感觉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useProjectStore } from '@/store/projectStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
import { useAiChatStore, type ChatEntry } from '@/store/aiChatStore';
import type { Dataset } from '@/data/schema';
import AiAssistantPage from '@/ui/pages/AiAssistantPage';

/** 假视口：内容 1200px、可视 400px → 最大 scrollTop = 800。 */
const VIEWPORT = { scrollHeight: 1200, clientHeight: 400 };
/** 浏览器里的「已滚到底」位置。 */
const MAX_SCROLL = VIEWPORT.scrollHeight - VIEWPORT.clientHeight;

const scrollTops = new WeakMap<HTMLElement, number>();
const scrollCalls: { top: number; behavior: string }[] = [];

/** 给 HTMLElement.prototype 装假滚动（用例结束后删除，恢复 jsdom 原状）。 */
function installLayoutMock(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return VIEWPORT.scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return VIEWPORT.clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(): number {
      return scrollTops.get(this as HTMLElement) ?? 0;
    },
    set(value: number) {
      scrollTops.set(this as HTMLElement, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: { top: number; behavior: string }) {
      scrollCalls.push(options);
      // 与真实浏览器一致：滚过头会被钳制到「内容高度 - 视口高度」。
      scrollTops.set(this, Math.max(0, Math.min(options.top, MAX_SCROLL)));
    },
  });
}

function uninstallLayoutMock(): void {
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop', 'scrollTo']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
}

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

function entry(id: string, role: ChatEntry['role'], text: string): ChatEntry {
  return { id, role, text, ...(role === 'assistant' ? { ok: true, scope: 'summary' as const } : {}) };
}

/** 预置一段已有会话（等价于「上次问完切走，现在切回来」）。 */
function seedConversation(): void {
  useAiChatStore.setState({
    entries: [entry('u1', 'user', '这批数据受控吗？'), entry('a1', 'assistant', '过程受控，无判异点。')],
    question: '',
    allowRaw: false,
    loading: false,
  });
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

describe('AI 助手 —— 微信式对话视窗（P7）', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
    useProjectStore.getState().clearDataset();
    useProjectStore.setState({ aiUsageLogs: [], project: null });
    useDiagnosisStore.getState().clearFullDiagnosis();
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
    scrollCalls.length = 0;
    installLayoutMock();
  });

  afterEach(() => {
    uninstallLayoutMock();
    vi.unstubAllGlobals();
  });

  it('进入页面（已有历史消息）→ 视窗默认停在最底部', () => {
    prepare();
    seedConversation();
    renderPage();
    const box = screen.getByTestId('ai-conversation-scroll');
    expect(box.scrollTop).toBe(MAX_SCROLL);
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls[scrollCalls.length - 1]).toEqual({ top: VIEWPORT.scrollHeight, behavior: 'auto' });
  });

  it('用户上拉看历史 → 新消息不会把视窗拽回底部', () => {
    prepare();
    seedConversation();
    renderPage();
    const box = screen.getByTestId('ai-conversation-scroll');

    // 上拉到顶部附近（距底 700px > 48px 阈值）
    box.scrollTop = 100;
    fireEvent.scroll(box);

    act(() => {
      useAiChatStore.getState().appendEntry(entry('u2', 'user', '再看一眼转轴直径'));
    });

    expect(box.scrollTop).toBe(100);
  });

  it('用户再滚回底部（阈值内也算）→ 恢复跟随', () => {
    prepare();
    seedConversation();
    renderPage();
    const box = screen.getByTestId('ai-conversation-scroll');

    box.scrollTop = 100;
    fireEvent.scroll(box);
    // 滚回到「距底 20px」——仍在 48px 容差内，算贴底。
    box.scrollTop = MAX_SCROLL - 20;
    fireEvent.scroll(box);

    act(() => {
      useAiChatStore.getState().appendEntry(entry('u3', 'user', '那 Cpk 呢？'));
    });

    expect(box.scrollTop).toBe(MAX_SCROLL);
  });

  it('每次新增消息都会重新贴底（不能只贴一次）', () => {
    prepare();
    renderPage();
    const box = screen.getByTestId('ai-conversation-scroll');

    act(() => {
      useAiChatStore.getState().appendEntry(entry('u1', 'user', '第一个问题'));
    });
    expect(box.scrollTop).toBe(MAX_SCROLL);

    box.scrollTop = 0;
    fireEvent.scroll(box);
    box.scrollTop = MAX_SCROLL;
    fireEvent.scroll(box);

    act(() => {
      useAiChatStore.getState().appendEntry(entry('a1', 'assistant', '第一个回答'));
    });
    expect(box.scrollTop).toBe(MAX_SCROLL);
  });

  it('每条消息都有复制按钮（我提的问题同样能复制）', async () => {
    prepare();
    seedConversation();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();

    expect(screen.getByTestId('ai-copy-u1')).toBeInTheDocument();
    expect(screen.getByTestId('ai-copy-a1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-copy-u1'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('这批数据受控吗？');
    });
    expect(screen.getByTestId('ai-copy-u1').textContent).toContain('已复制');
  });

  it('「复制对话」把整段会话拼成纯文本（含角色前缀、逐条不漏）', async () => {
    prepare();
    seedConversation();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();
    fireEvent.click(screen.getByTestId('ai-copy-transcript'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('我：这批数据受控吗？\n\nAI 助手：过程受控，无判异点。');
    });
  });

  it('空会话时「复制对话 / 清空对话」不可点（没有内容可复制）', () => {
    prepare();
    renderPage();
    expect(screen.getByTestId('ai-copy-transcript')).toBeDisabled();
    expect(screen.getByTestId('ai-clear-chat')).toBeDisabled();
  });

  it('默认只保留对话：快捷指令 / 数据主权 / 诊断入口收在「+」面板里且默认收起', () => {
    prepare();
    useDiagnosisStore.getState().setFullDiagnosis({
      id: 'diag-z',
      content: '# 上次的诊断',
      generatedAt: '2026-09-19T01:00:00.000Z',
      model: 'qwen3-max',
      scope: 'summary',
      sentFields: [],
      projectName: 'p',
      characteristicCount: 1,
    });
    seedConversation();
    renderPage();

    // 页面主体是对话本身
    expect(screen.getByTestId('ai-conversation')).toBeVisible();
    // 其余控件都在收起的面板里
    expect(screen.getByTestId('ai-tools-panel')).not.toBeVisible();
    expect(screen.getByTestId('ai-toggle-tools')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTestId('ai-toggle-tools'));
    expect(screen.getByTestId('ai-tools-panel')).toBeVisible();
    expect(screen.getByTestId('ai-toggle-tools')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('ai-full-diagnosis')).toBeVisible();
  });

  it('会话区是「固定视口的内部滚动容器」——不是把整页撑长（否则就不叫微信式了）', () => {
    prepare();
    seedConversation();
    renderPage();

    const cs = getComputedStyle(screen.getByTestId('ai-conversation-scroll'));
    // 内部滚动：历史消息在这里面滚，而不是滚整个页面
    expect(cs.overflowY).toBe('auto');
    // flexBasis:0 → 高度由「父容器剩余空间」决定（固定视口），而不是被内容高度撑开
    expect(cs.flexBasis).toBe('0px');
    expect(cs.minHeight).toBe('200px');
  });

  it('诊断报告已保存时，顶栏有「诊断报告（已保存）」入口，点一下直接展开面板', () => {
    prepare();
    useDiagnosisStore.getState().setFullDiagnosis({
      id: 'diag-z',
      content: '# 上次的诊断',
      generatedAt: '2026-09-19T01:00:00.000Z',
      model: 'qwen3-max',
      scope: 'summary',
      sentFields: [],
      projectName: 'p',
      characteristicCount: 1,
    });
    renderPage();

    fireEvent.click(screen.getByTestId('ai-open-diagnosis'));
    expect(screen.getByTestId('ai-tools-panel')).toBeVisible();
  });
});