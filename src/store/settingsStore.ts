/**
 * settingsStore —— AI 配置、模式、规则默认值、主题。
 *
 * 出处：架构文档 §5、§7；PRD §6。
 *
 * T05 增强（**保持既有 API 不变**，仅新增字段与动作）：
 * - 新增 `probeStatus`（idle/probing/ai/offline）供设置页显示探测进度；
 * - 新增 `lastProbeReason`（离线原因码）供徽标 tooltip；
 * - 新增 `availableModels`（探测成功后可选模型）——保留为可选扩展点；
 * - 新增 `setProbeStatus` / `applyProbeResult` / `resetMode` 供 `useAiAvailability` 驱动；
 * - AI 配置支持持久化到注入的 `KeyValueStore`（默认内存；UI 层挂载浏览器实现）。
 *
 * 兼容性：`mode` / `modeReason` / `aiConfig` / `setMode` / `setAiConfig` 原样保留，
 * T03 已验收的 ModeBadge / AiGate 无需改动。
 */

import { create } from 'zustand';
import { DEFAULT_MAX_TOKENS } from '@/services/ai/types';
import type { AiProbeResult } from '@/services/ai/types';

/** 运行模式：离线 / AI。 */
export type AppMode = 'offline' | 'ai';

/** AI 探测状态。 */
export type AiProbeStatus = 'idle' | 'probing' | 'ai' | 'offline';

/** AI 配置（T05 使用完整字段；此处保留结构）。 */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 最大输出 tokens（推理模型思考过程同样计入该配额，默认 4096；
   * 见 `services/ai/types.ts` 的 `DEFAULT_MAX_TOKENS`）。
   */
  maxTokens: number;
  /**
   * 是否关闭模型思考（默认 **true**）。
   *
   * 对不收敛的推理模型（如 qwen3.5:9b），思考会吃光输出配额且始终不产出正文；
   * 开启后请求体带 `reasoning_effort: 'none'`，可直接输出正文且更快。
   * 普通模型忽略该字段，故默认开启对本机 Ollama 全系安全。
   */
  disableThinking: boolean;
  /** 允许发送原始明细（默认 false）。 */
  allowRawData: boolean;
}

/** 设置项持久化 key。 */
export const SETTINGS_STORAGE_KEY = 'hogo-qa-settings';

/** 最小持久化接口（避免直接依赖浏览器 API；UI 层注入实现）。 */
export interface SettingsPersistence {
  load: () => AiConfig | null;
  save: (config: AiConfig) => void;
}

interface SettingsState {
  mode: AppMode;
  /** 模式探测原因（供徽标 tooltip 说明）。 */
  modeReason: string;
  aiConfig: AiConfig;
  /** 探测状态。 */
  probeStatus: AiProbeStatus;
  /** 最近一次探测的离线原因码（'' 表示无）。 */
  lastProbeReason: string;

  setMode: (mode: AppMode, reason?: string) => void;
  setAiConfig: (config: Partial<AiConfig>) => void;
  setProbeStatus: (status: AiProbeStatus) => void;
  /** 应用一次探测结果：成功→ai，失败→offline 且保留配置。 */
  applyProbeResult: (result: AiProbeResult) => void;
  /** 重置为未配置状态（清空密钥，用于「清除配置」）。 */
  resetMode: () => void;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: DEFAULT_MAX_TOKENS,
  disableThinking: true,
  allowRawData: false,
};

/** 最大输出 tokens 的最小合法值（无上限：用户明确要求不限制最大 TOKEN）。 */
export const MIN_MAX_TOKENS = 1;

/**
 * 容错归一化 `maxTokens`：仅接受「有限、为整数且 >= 1」的数值，**不设上限**；
 * 非法值（非数 / NaN / 非整数 / 小于 1）回落默认 4096。
 *
 * `Number.isInteger` 已同时覆盖「有限」与「为整数」两个条件。
 *
 * @param raw 原始值
 * @returns 合法的 maxTokens
 */
function sanitizeMaxTokens(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_MAX_TOKENS) {
    return raw;
  }
  return DEFAULT_AI_CONFIG.maxTokens;
}

/**
 * 容错归一化：把从持久化读回的任意值收窄为合法 `AiConfig`。
 *
 * 处理三类脏数据（手动篡改 / 版本残留 / 字段缺失）：
 * - 非对象（字符串、数组、null…）→ 返回 null，调用方回落默认（视为无配置）；
 * - 字段缺失或类型不符 → **逐字段**回落 `DEFAULT_AI_CONFIG`（不整段丢弃，
 *   尽量保留用户已填写且合法的部分）。
 *
 * 纯函数：不触碰 DOM / 存储，可独立单测。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法 `AiConfig`；`raw` 非普通对象时返回 null
 */
export function sanitizeAiConfig(raw: unknown): AiConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  return {
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : DEFAULT_AI_CONFIG.baseUrl,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : DEFAULT_AI_CONFIG.apiKey,
    model: typeof r.model === 'string' ? r.model : DEFAULT_AI_CONFIG.model,
    maxTokens: sanitizeMaxTokens(r.maxTokens),
    disableThinking:
      typeof r.disableThinking === 'boolean' ? r.disableThinking : DEFAULT_AI_CONFIG.disableThinking,
    allowRawData: typeof r.allowRawData === 'boolean' ? r.allowRawData : DEFAULT_AI_CONFIG.allowRawData,
  };
}

export const useSettingsStore = create<SettingsState>((set) => ({
  mode: 'offline',
  modeReason: '尚未配置 AI 服务',
  aiConfig: { ...DEFAULT_AI_CONFIG },
  probeStatus: 'idle',
  lastProbeReason: '',

  setMode: (mode, reason = '') => set({ mode, modeReason: reason }),

  setAiConfig: (config) => set((s) => ({ aiConfig: { ...s.aiConfig, ...config } })),

  setProbeStatus: (status) => set({ probeStatus: status }),

  applyProbeResult: (result) =>
    set((s) => ({
      mode: result.mode,
      modeReason: result.message,
      probeStatus: result.mode === 'ai' ? 'ai' : 'offline',
      lastProbeReason: result.reason,
      // 探测失败时保留配置（keepConfig=true）；成功同样保留，故 aiConfig 不变。
      aiConfig: s.aiConfig,
    })),

  resetMode: () =>
    set({
      mode: 'offline',
      modeReason: '尚未配置 AI 服务',
      probeStatus: 'idle',
      lastProbeReason: '',
      aiConfig: { ...DEFAULT_AI_CONFIG },
    }),
}));

/**
 * 从持久化存储加载 AI 配置（在应用启动时调用）。
 *
 * @param persistence 持久化实现（可注入；默认 no-op）
 */
export function hydrateAiConfig(persistence: SettingsPersistence | null): void {
  if (!persistence) {
    return;
  }
  const loaded = persistence.load();
  if (loaded) {
    useSettingsStore.getState().setAiConfig(loaded);
  }
}

/**
 * 保存当前 AI 配置到持久化存储。
 *
 * @param persistence 持久化实现
 */
export function persistAiConfig(persistence: SettingsPersistence | null): void {
  if (!persistence) {
    return;
  }
  persistence.save(useSettingsStore.getState().aiConfig);
}
