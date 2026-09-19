/**
 * useAiAvailability —— 启动探测 AI 可用性并降级（架构 §7.1；T05 验收要点 1）。
 *
 * 三态：`idle`（未探测）/ `probing`（探测中）/ `ai`（可用）/ `offline`（不可用）。
 *
 * - 启动时读 settingsStore.aiConfig；
 * - baseUrl 为空 → 离线（NO_BASE_URL），不发起任何网络请求（数据主权 G3）；
 *   注意：**无 Key 的本地服务（Ollama / LM Studio）属合法配置**，只要 baseUrl 非空即照常探测；
 * - baseUrl 非空 → probeAi（3s 超时）；成功 → AI 模式；失败/超时 → 离线 + 保留配置；
 * - 暴露 `retry()` 供设置页「重试」按钮即时重探（无需刷新）。
 *
 * 探测函数可注入（`probe` 参数），默认走 `@/services/ai` 的 `probeAi`，
 * 测试可注入假实现，避免真实网络。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiClientConfig, AiProbeResult } from '@/services/ai/types';
import { probeAi } from '@/services/ai';
import { useSettingsStore } from '@/store/settingsStore';

/** 探测函数签名（可注入）。 */
export type ProbeFn = (config: AiClientConfig) => Promise<AiProbeResult>;

/** Hook 返回结构。 */
export interface AiAvailability {
  /** 当前模式。 */
  mode: 'offline' | 'ai';
  /** 探测状态。 */
  status: 'idle' | 'probing' | 'ai' | 'offline';
  /** 是否正在探测。 */
  probing: boolean;
  /** 离线原因码（'' 表示无 / 已可用）。 */
  reason: string;
  /** 面向用户说明。 */
  message: string;
  /** 手动重试探测。 */
  retry: () => Promise<AiProbeResult>;
}

/** 提取探测所需的配置子集。 */
function toClientConfig(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): AiClientConfig {
  return { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model };
}

/**
 * 默认探测实现（模块级常量，保证引用稳定，避免 effect 依赖抖动）。
 *
 * @param config AI 配置
 * @returns 探测结果
 */
const defaultProbe: ProbeFn = (config) => probeAi(config);

/**
 * 探测定时器句柄（供清理）。
 */
interface DebounceState {
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * AI 可用性探测 Hook。
 *
 * @param probeFn 可注入的探测实现（默认 `probeAi`）
 * @param autoProbe 是否在挂载时自动探测（默认 true）
 * @returns 可用性状态与 retry 动作
 */
export function useAiAvailability(
  probeFn: ProbeFn = defaultProbe,
  autoProbe = true,
): AiAvailability {
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const mode = useSettingsStore((s) => s.mode);
  const probeStatus = useSettingsStore((s) => s.probeStatus);
  const lastProbeReason = useSettingsStore((s) => s.lastProbeReason);
  const modeReason = useSettingsStore((s) => s.modeReason);
  const setProbeStatus = useSettingsStore((s) => s.setProbeStatus);
  const applyProbeResult = useSettingsStore((s) => s.applyProbeResult);

  const [reason, setReason] = useState<string>(lastProbeReason);
  const [message, setMessage] = useState<string>(modeReason);
  const debounce = useRef<DebounceState>({ timer: null });

  // 用 ref 持有最新探测实现，避免其引用变化导致 runProbe / effect 抖动。
  const probeFnRef = useRef<ProbeFn>(probeFn);
  probeFnRef.current = probeFn;

  /**
   * 执行一次探测并落库。
   *
   * @returns 探测结果
   */
  const runProbe = useCallback(async (): Promise<AiProbeResult> => {
    const config = toClientConfig(useSettingsStore.getState().aiConfig);

    // baseUrl 为空：无服务地址可探测，直接离线，绝不发起网络请求（G3 数据主权）。
    // 注意：无 Key 但 baseUrl 非空（本机 Ollama / LM Studio）属合法配置，**照常探测**，
    // 不得在此处按 apiKey 短路——否则「兼容 Ollama 无 Key」的语义会在探测前被拦掉。
    if (config.baseUrl.trim().length === 0) {
      const result: AiProbeResult = {
        mode: 'offline',
        reason: 'NO_BASE_URL',
        keepConfig: true,
        message: '未配置 Base URL，当前为离线模式。',
      };
      setProbeStatus('offline');
      applyProbeResult(result);
      setReason(result.reason);
      setMessage(result.message);
      return result;
    }

    setProbeStatus('probing');
    const result = await probeFnRef.current(config);
    applyProbeResult(result);
    setReason(result.reason);
    setMessage(result.message);
    return result;
  }, [applyProbeResult, setProbeStatus]);

  // 启动（或配置变更）自动探测。
  useEffect(() => {
    if (!autoProbe) {
      return undefined;
    }
    let cancelled = false;
    const state = debounce.current;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      if (!cancelled) {
        void runProbe();
      }
    }, 0);
    return () => {
      cancelled = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    };
    // 仅在 baseUrl/apiKey/model 变化时重探（避免 allowRawData 触发）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiConfig.baseUrl, aiConfig.apiKey, aiConfig.model, autoProbe, runProbe]);

  return {
    mode,
    status: probeStatus,
    probing: probeStatus === 'probing',
    reason,
    message,
    retry: runProbe,
  };
}

export default useAiAvailability;
