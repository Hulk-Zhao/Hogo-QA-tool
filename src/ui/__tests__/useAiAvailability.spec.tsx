// @vitest-environment jsdom
/**
 * useAiAvailability 测试（架构 §7.1；T05 验收要点 1）。
 *
 * 验证三态探测：NO_KEY（不发请求）→ offline；成功 → ai；失败 → offline。
 * 探测函数注入假实现，避免真实网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AiClientConfig, AiProbeResult } from '@/services/ai/types';
import { useAiAvailability } from '@/ui/hooks/useAiAvailability';
import { useSettingsStore } from '@/store/settingsStore';

function resetStore(): void {
  useSettingsStore.getState().resetMode();
}

describe('useAiAvailability', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('无 Base URL → offline（NO_BASE_URL），且不调用探测函数（不打网络）', async () => {
    const probe = vi.fn<(...args: unknown[]) => Promise<AiProbeResult>>();
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => {
      expect(result.current.status).toBe('offline');
    });
    // 唯一允许的「不探测」短路：无服务地址可探测。
    expect(probe).not.toHaveBeenCalled();
    expect(result.current.reason).toBe('NO_BASE_URL');
  });

  it('无 Key 但 baseUrl 非空（本机 Ollama）→ 走注入的 probeFn，不再按 Key 短路', async () => {
    useSettingsStore
      .getState()
      .setAiConfig({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' });
    const probe = vi.fn(async (_config: AiClientConfig): Promise<AiProbeResult> => ({
      mode: 'ai',
      reason: '',
      keepConfig: true,
      message: 'AI 服务可用。',
    }));
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => {
      expect(result.current.status).toBe('ai');
    });
    // 副作用断言：假探测函数必须**确实被调用**（修复前 key 空会短路，此处会失败）。
    expect(probe).toHaveBeenCalledTimes(1);
    // 断言透传配置：apiKey 为空但 baseUrl / model 必须原样带入。
    expect(probe.mock.calls[0][0]).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
    });
    expect(useSettingsStore.getState().mode).toBe('ai');
  });

  it('baseUrl 为空 → 不打网络（probeFn 不被调用）', async () => {
    useSettingsStore.getState().setAiConfig({ baseUrl: '', apiKey: 'sk-x', model: 'm' });
    const probe = vi.fn(async (): Promise<AiProbeResult> => ({
      mode: 'ai',
      reason: '',
      keepConfig: true,
      message: 'ok',
    }));
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => {
      expect(result.current.status).toBe('offline');
    });
    expect(probe).not.toHaveBeenCalled();
    expect(result.current.reason).toBe('NO_BASE_URL');
  });

  it('有 Key 且可达 → status=ai、mode=ai', async () => {
    useSettingsStore.getState().setAiConfig({ baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' });
    const probe = vi.fn(async (): Promise<AiProbeResult> => ({
      mode: 'ai',
      reason: '',
      keepConfig: true,
      message: 'AI 服务可用。',
    }));
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => {
      expect(result.current.status).toBe('ai');
    });
    expect(result.current.mode).toBe('ai');
    expect(useSettingsStore.getState().mode).toBe('ai');
  });

  it('有 Key 但不可达 → offline 且保留配置', async () => {
    useSettingsStore.getState().setAiConfig({ baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' });
    const probe = vi.fn(async (): Promise<AiProbeResult> => ({
      mode: 'offline',
      reason: 'UNREACHABLE',
      keepConfig: true,
      message: 'AI 服务不可用，已降级。',
    }));
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => {
      expect(result.current.status).toBe('offline');
    });
    expect(result.current.reason).toBe('UNREACHABLE');
    // 配置保留
    expect(useSettingsStore.getState().aiConfig.apiKey).toBe('sk-x');
  });

  it('retry() 重新探测，可从未达切换为可用', async () => {
    useSettingsStore.getState().setAiConfig({ baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' });
    let attempt = 0;
    const probe = vi.fn(async (): Promise<AiProbeResult> => {
      attempt += 1;
      if (attempt === 1) {
        return { mode: 'offline', reason: 'UNREACHABLE', keepConfig: true, message: '不可用' };
      }
      return { mode: 'ai', reason: '', keepConfig: true, message: '可用' };
    });
    const { result } = renderHook(() => useAiAvailability(probe));
    await waitFor(() => expect(result.current.status).toBe('offline'));

    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('ai'));
  });
});
