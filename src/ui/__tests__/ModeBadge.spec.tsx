// @vitest-environment jsdom
/**
 * ModeBadge 启动探测接线回归测试（永久）。
 *
 * 背景：`ModeBadge` 常驻顶栏，是本项目**启动探测**的唯一驱动点
 * （`ModeBadge` → `useAiAvailability()` → `probeAi`）。此前该文件无任何测试，
 * 一旦有人把 `useAiAvailability()` 从 ModeBadge 删掉（本项目已反复出现
 * 「函数写好但从未接线 / 接线被误删」），冷启动时 AI 可用性将永远停在 offline。
 *
 * 证伪立场：本测试用**真实 default probe + 注入的全局 fetch** 断言副作用——
 * 若移除 ModeBadge 内的 `useAiAvailability()` 调用，fetch 不会被触发、
 * store.mode 不会变 'ai'，下述断言必红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import ModeBadge from '@/ui/components/ModeBadge';

/** 注入一个「/models 200」的全局 fetch，返回可断言的 spy。 */
function stubFetchOk(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderBadge(): void {
  render(
    <ThemeProvider theme={theme}>
      <ModeBadge />
    </ThemeProvider>,
  );
}

describe('ModeBadge —— 启动探测接线', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
  });

  afterEach(() => {
    useSettingsStore.getState().resetMode();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('无 Key 但已配置 baseUrl → 挂载即真实探测 /models，并切到 AI 模式', async () => {
    useSettingsStore
      .getState()
      .setAiConfig({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' });
    const fetchSpy = stubFetchOk();

    renderBadge();

    // 副作用 1：真实 probeAi 确实发起了 /models 请求（证明 ModeBadge 驱动了探测）。
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/models');

    // 副作用 2：探测结果落库 → 徽标显示「AI 模式」。
    await waitFor(() => {
      expect(screen.getByTestId('mode-badge').textContent).toContain('AI 模式');
    });
    expect(useSettingsStore.getState().mode).toBe('ai');
  });

  it('未配置 baseUrl → 不发任何请求，徽标为「离线模式」（数据主权 G3）', async () => {
    const fetchSpy = stubFetchOk();

    renderBadge();

    await waitFor(() => {
      expect(screen.getByTestId('mode-badge').textContent).toContain('离线模式');
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().mode).toBe('offline');
  });
});
