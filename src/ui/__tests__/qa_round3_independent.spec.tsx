// @vitest-environment jsdom
/**
 * QA 第三轮独立验证（T04/T05 全链路）。
 *
 * 证伪立场，四组独立断言：
 *  R1 路由：逐路径断言**唯一页面根 testid** 出现（证明渲染的是目标组件，
 *          而非被 `*` 兜底重定向回 /import）；并以「伪路径 → import-page」反证兜底存在。
 *  R2 EmptyState：无 testId 时不带 data-testid，行为与带 testId 时除属性外一致。
 *  R3 T04 常数：getConstants(22..25).c4 独立复算、D3/B3 null 语义、n 越界 RangeError。
 *  R4 T05 AI 三态：无 Base URL 时 **全局 fetch 零调用**（数据主权 G3 技术证明）、成功→ai、失败→offline。
 *
 * 注意：API 为 getConstants(n) 返回整对象，非 getConstant(name, n)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import AppShell from '@/ui/layout/AppShell';
import EmptyState from '@/ui/components/EmptyState';
import { getConstants, hasD3, hasB3 } from '@/core/constants/controlChartConstants';
import { useAiAvailability } from '@/ui/hooks/useAiAvailability';
import { probeAi } from '@/services/ai';
import type { AiProbeResult } from '@/services/ai/types';
import { useSettingsStore } from '@/store/settingsStore';

// ---------------------------------------------------------------------------
// R1 路由：每条路径断言唯一 root testid
// ---------------------------------------------------------------------------
describe('QA-R1 路由渲染目标组件（非兜底重定向）', () => {
  // 说明：/capability、/report 在「空 store」下会按设计 early-return EmptyState
  // （root Stack testid 仅在「有数据」时出现）；/ai 在离线模式下渲染 ai-assistant-offline 门控。
  // 因此每条路径断言的是「该页在空数据下的**判别性标记**」，用于证明挂载的是目标组件，
  // 而非被 `*` 兜底重定向回 /import（后者只会有 import-page）。
  const CASES: { path: string; marker: () => void; mustNotBeImport: boolean }[] = [
    { path: '/import', marker: () => expect(screen.getByTestId('import-page')).toBeInTheDocument(), mustNotBeImport: false },
    { path: '/capability', marker: () => expect(screen.getByText('尚无可分析的数据')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/control-chart', marker: () => expect(screen.getByTestId('control-chart-page')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/pareto', marker: () => expect(screen.getByTestId('pareto-page')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/report', marker: () => expect(screen.getByText('尚无可导出的数据')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/ai', marker: () => expect(screen.getByTestId('ai-assistant-offline')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/settings', marker: () => expect(screen.getByTestId('settings-page')).toBeInTheDocument(), mustNotBeImport: true },
    { path: '/library', marker: () => expect(screen.getByTestId('project-library-page')).toBeInTheDocument(), mustNotBeImport: true },
  ];
  afterEach(() => cleanup());

  CASES.forEach(({ path, marker, mustNotBeImport }) => {
    it(`${path} → 渲染该页（非兜底页）`, () => {
      render(
        <ThemeProvider theme={theme}>
          <MemoryRouter initialEntries={[path]}>
            <AppShell />
          </MemoryRouter>
        </ThemeProvider>,
      );
      marker();
      if (mustNotBeImport) {
        // 反向证据：没有落到 import 兜底
        expect(screen.queryByTestId('import-page')).not.toBeInTheDocument();
      }
    });
  });

  it('反证兜底：未知路径 → import-page（证明上面断言有判别力）', () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={['/no-such-route']}>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('import-page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R2 EmptyState
// ---------------------------------------------------------------------------
describe('QA-R2 EmptyState testId 可选且向后兼容', () => {
  afterEach(() => cleanup());

  it('无 testId：渲染 title/description/action，且**根节点**不带 data-testid', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <EmptyState title="暂无数据" description="请先导入" action={<button type="button">去导入</button>} />
      </ThemeProvider>,
    );
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(screen.getByText('请先导入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去导入' })).toBeInTheDocument();
    // 注：MUI SvgIcon 自身会带 data-testid="InboxIcon"，故只断根节点（EmptyState 的 Box）。
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.hasAttribute('data-testid')).toBe(false);
    // 反向对照：不存在任何自定义 testid（如 empty-xyz）
    expect(screen.queryByTestId('empty-xyz')).toBeNull();
  });

  it('传 testId：**根节点**带该 data-testid，内容不变', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <EmptyState title="暂无数据" description="请先导入" testId="empty-xyz" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('empty-xyz')).toBeInTheDocument();
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-testid')).toBe('empty-xyz');
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    expect(screen.getByText('请先导入')).toBeInTheDocument();
  });

  it('缺省 description/action：不渲染多余元素', () => {
    render(
      <ThemeProvider theme={theme}>
        <EmptyState title="仅标题" />
      </ThemeProvider>,
    );
    expect(screen.getByText('仅标题')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R3 T04 常数
// ---------------------------------------------------------------------------
describe('QA-R3 T04 getConstants 数值与边界', () => {
  it('getConstants(22..25).c4 与 Γ 公式独立复算一致（4 位）', () => {
    const expectC4: Record<number, number> = { 22: 0.9882, 23: 0.9887, 24: 0.9892, 25: 0.9896 };
    for (const n of [22, 23, 24, 25]) {
      expect(getConstants(n).c4).toBeCloseTo(expectC4[n], 4);
    }
  });

  it('D3 n≤6 为 null / n≥7 数值；B3 n≤5 为 null / n≥6 数值', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      expect(getConstants(n).D3).toBeNull();
      expect(hasD3(n)).toBe(false);
    }
    expect(getConstants(7).D3).not.toBeNull();
    expect(hasD3(7)).toBe(true);

    for (const n of [2, 3, 4, 5]) {
      expect(getConstants(n).B3).toBeNull();
      expect(hasB3(n)).toBe(false);
    }
    expect(getConstants(6).B3).not.toBeNull();
    expect(hasB3(6)).toBe(true);
  });

  it('n 越界（1 / 26 / 非整数）抛 RangeError；边界 2/25 不抛', () => {
    expect(() => getConstants(1)).toThrowError(RangeError);
    expect(() => getConstants(26)).toThrowError(RangeError);
    expect(() => getConstants(5.5)).toThrowError(RangeError);
    expect(() => getConstants(2)).not.toThrow();
    expect(() => getConstants(25)).not.toThrow();
  });

  it('抽样交叉 n=5 常数', () => {
    const c5 = getConstants(5);
    expect(c5.d2).toBeCloseTo(2.326, 3);
    expect(c5.A2).toBeCloseTo(0.577, 3);
    expect(c5.D4).toBeCloseTo(2.114, 3);
  });
});

// ---------------------------------------------------------------------------
// R4 T05 AI 三态
// ---------------------------------------------------------------------------
describe('QA-R4 T05 useAiAvailability 三态', () => {
  beforeEach(() => {
    useSettingsStore.getState().setAiConfig({ baseUrl: '', apiKey: '', model: '' });
    useSettingsStore.getState().resetMode();
  });
  afterEach(() => {
    useSettingsStore.getState().resetMode();
    vi.restoreAllMocks();
  });

  it('无 Base URL：全局 fetch 零调用（G3），status=offline/reason=NO_BASE_URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 用**真实** default probe（不注入 mock）——若实现在 baseUrl 为空时仍发起请求，
    // 真实 probeAi 会尝试 fetch，spy 必捕获。
    const { result } = renderHook(() => useAiAvailability());
    await waitFor(() => expect(result.current.status).toBe('offline'));
    expect(result.current.reason).toBe('NO_BASE_URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('无 Key 但 baseUrl 非空（本机 Ollama）→ 真实 probeAi 确实发起 fetch（D3 回归）', async () => {
    useSettingsStore
      .getState()
      .setAiConfig({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    } as never);

    const { result } = renderHook(() => useAiAvailability());
    await waitFor(() => expect(result.current.status).toBe('ai'));
    // 副作用断言：真实探测确实打了 /models（修复前会按空 Key 短路，零调用）。
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/models');
  });

  it('有 Key 且 /models 200 → ai（真实 probeAi + 注入 fetch）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const res = await probeAi(
      { baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' },
      {},
      fetchMock as never,
    );
    expect(res.mode).toBe('ai');
  });

  it('有 Key 但 fetch 抛错 → offline（归一化，不抛）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await probeAi(
      { baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' },
      {},
      fetchMock as never,
    );
    expect(res.mode).toBe('offline');
    expect(res.reason).toBe('UNREACHABLE');
  });

  it('有 Key 但 401 → offline（auth 场景不误判为可用）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }));
    const res = await probeAi(
      { baseUrl: 'https://a.com/v1', apiKey: 'bad', model: 'm' },
      {},
      fetchMock as never,
    );
    expect(res.mode).toBe('offline');
  });

  it('设置 Key 后 hook 触发探测 → ai（端到端注入）', async () => {
    useSettingsStore.getState().setAiConfig({ baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' });
    const probe = vi.fn(
      async (): Promise<AiProbeResult> => ({
        mode: 'ai',
        reason: '',
        keepConfig: true,
        message: 'ok',
      }),
    );
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => expect(result.current.status).toBe('ai'));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe('ai');
  });
});
