/**
 * settingsStore —— AI 配置、模式、判异准则开关、报表导出范围、主题。
 *
 * 出处：架构文档 §5、§7；PRD §6、P0-10/P0-11、P0-18。
 *
 * T05 增强（**保持既有 API 不变**，仅新增字段与动作）：
 * - 新增 `probeStatus`（idle/probing/ai/offline）供设置页显示探测进度；
 * - 新增 `lastProbeReason`（离线原因码）供徽标 tooltip；
 * - 新增 `availableModels`（探测成功后可选模型）——保留为可选扩展点；
 * - 新增 `setProbeStatus` / `applyProbeResult` / `resetMode` 供 `useAiAvailability` 驱动；
 * - AI 配置支持持久化到注入的 `KeyValueStore`（默认内存；UI 层挂载浏览器实现）。
 *
 * 第五轮 P0 修复新增（用户明确要求「不要 useState」的两处设置项）：
 * - `rulesConfig`：判异准则 12 条开关，原本在 ControlChartPage 与 SettingsPage
 *   各持一份 `useState`，**刷新即丢**；现统一进本 store 并持久化；
 * - `exportOptions`：报表导出范围 7 项勾选（4 表 + 3 图），原本 2 项且是
 *   `useState`；现进本 store 并持久化。
 *
 * 持久化分两条 key（互不影响、可独立降级）：
 * - `hogo-qa-settings`：AI 配置（`SettingsPersistence`，历史契约，逐字段 sanitize）；
 * - `hogo-qa-preferences`：判异开关 + 导出范围（`PreferencesPersistence`）。
 * 拆两条 key 的收益：AI 配置是**敏感且偶发损坏**（手填 Key）的，偏好是**高频变更**
 * 的；分开后任一损坏都不会拖垮另一条，且旧版本残留的 AI 配置可原样读回。
 *
 * 兼容性：`mode` / `modeReason` / `aiConfig` / `setMode` / `setAiConfig` 原样保留，
 * T03 已验收的 ModeBadge / AiGate 无需改动。
 */

import { create } from 'zustand';
import {
  ALL_RULE_IDS,
  defaultToggleConfig,
  type NelsonRuleId,
  type RuleId,
  type RuleToggleConfig,
  type WesternRuleId,
} from '@/core';
import { DEFAULT_MAX_TOKENS } from '@/services/ai/types';
import type { AiProbeResult } from '@/services/ai/types';
import {
  DEFAULT_EXPORT_OPTIONS,
  sanitizeExportOptions,
  type ExportOptions,
} from '@/services/report/exportOptions';

/** 运行模式：离线 / AI。 */
export type AppMode = 'offline' | 'ai';

/** AI 探测状态。 */
export type AiProbeStatus = 'idle' | 'probing' | 'ai' | 'offline';

/** 判异准则分组。 */
export type RuleGroup = 'westernElectric' | 'nelson';

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

/** 偏好（判异开关 + 导出范围）持久化 key。 */
export const PREFERENCES_STORAGE_KEY = 'hogo-qa-preferences';

/** 最小持久化接口（避免直接依赖浏览器 API；UI 层注入实现）。 */
export interface SettingsPersistence {
  load: () => AiConfig | null;
  save: (config: AiConfig) => void;
  /**
   * 删除整键（「清除已保存的 AI 配置」用）。
   *
   * 与 `save` 的区别：`save(DEFAULT_AI_CONFIG)` 只把字段写空（密钥明文虽已
   * 不在，但配置对象仍在）；`clear()` 把键彻底删掉，是本轮 P1-D
   * 「把密钥从本机抹掉」的语义。契约：**不抛异常**。
   */
  clear: () => void;
}

/** 偏好持久化载荷。 */
export interface UiPreferences {
  rulesConfig: RuleToggleConfig;
  exportOptions: ExportOptions;
}

/** 偏好持久化接口（与 `SettingsPersistence` 同构，独立 key）。 */
export interface PreferencesPersistence {
  load: () => UiPreferences | null;
  save: (preferences: UiPreferences) => void;
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
  /** 判异准则 12 条开关（控制图页与设置页共用同一份，落盘）。 */
  rulesConfig: RuleToggleConfig;
  /** 报表导出范围 7 项勾选（落盘）。 */
  exportOptions: ExportOptions;

  setMode: (mode: AppMode, reason?: string) => void;
  setAiConfig: (config: Partial<AiConfig>) => void;
  setProbeStatus: (status: AiProbeStatus) => void;
  /** 应用一次探测结果：成功→ai，失败→offline 且保留配置。 */
  applyProbeResult: (result: AiProbeResult) => void;
  /** 重置为未配置状态（清空密钥，用于「清除配置」）。 */
  resetMode: () => void;
  /** 整体替换判异开关。 */
  setRulesConfig: (config: RuleToggleConfig) => void;
  /** 切换单条准则（W1..W4 / N1..N8）。 */
  setRule: (ruleId: RuleId, enabled: boolean) => void;
  /** 整组开/关（西方电气 4 条 / 尼尔森 8 条）。 */
  setRulesGroup: (group: RuleGroup, enabled: boolean) => void;
  /** 增量更新导出范围勾选。 */
  setExportOptions: (patch: Partial<ExportOptions>) => void;
  /** 恢复默认偏好（判异开关 + 导出范围）。 */
  resetPreferences: () => void;
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

/**
 * 容错归一化判异开关：**逐条**处理，非布尔值回落 `defaultToggleConfig()` 对应值。
 *
 * 关键场景：旧版本只持久化了部分规则（字段缺失）、或用户手工篡改了
 * localStorage。逐条回落可保证「读回后 12 条都有明确布尔值」，不会因一条脏
 * 数据把整份开关丢弃。`raw` 非对象时整体回落默认。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法的 RuleToggleConfig（永不抛异常）
 */
export function sanitizeRulesConfig(raw: unknown): RuleToggleConfig {
  const base = defaultToggleConfig();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return base;
  }
  const r = raw as Record<string, unknown>;
  const weRaw = r.westernElectric;
  const nelsonRaw = r.nelson;
  const we = typeof weRaw === 'object' && weRaw !== null ? (weRaw as Record<string, unknown>) : {};
  const nelson =
    typeof nelsonRaw === 'object' && nelsonRaw !== null ? (nelsonRaw as Record<string, unknown>) : {};
  const out: RuleToggleConfig = {
    westernElectric: { ...base.westernElectric },
    nelson: { ...base.nelson },
  };
  for (const id of ALL_RULE_IDS) {
    const pool = id.startsWith('W') ? we : nelson;
    const value = pool[id];
    if (typeof value === 'boolean') {
      if (id.startsWith('W')) {
        out.westernElectric[id as WesternRuleId] = value;
      } else {
        out.nelson[id as NelsonRuleId] = value;
      }
    }
  }
  return out;
}

/**
 * 容错归一化偏好载荷（判异开关 + 导出范围）。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法偏好；`raw` 非普通对象时返回 null（调用方回落默认）
 */
export function sanitizeUiPreferences(raw: unknown): UiPreferences | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  return {
    rulesConfig: sanitizeRulesConfig(r.rulesConfig),
    exportOptions: sanitizeExportOptions(r.exportOptions),
  };
}

export const useSettingsStore = create<SettingsState>((set) => ({
  mode: 'offline',
  modeReason: '尚未配置 AI 服务',
  aiConfig: { ...DEFAULT_AI_CONFIG },
  probeStatus: 'idle',
  lastProbeReason: '',
  rulesConfig: defaultToggleConfig(),
  exportOptions: { ...DEFAULT_EXPORT_OPTIONS },

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

  setRulesConfig: (config) => set({ rulesConfig: sanitizeRulesConfig(config) }),

  setRule: (ruleId, enabled) =>
    set((s) => {
      if (ruleId.startsWith('W')) {
        const we = { ...s.rulesConfig.westernElectric, [ruleId as WesternRuleId]: enabled };
        return { rulesConfig: { ...s.rulesConfig, westernElectric: we } };
      }
      const nelson = { ...s.rulesConfig.nelson, [ruleId as NelsonRuleId]: enabled };
      return { rulesConfig: { ...s.rulesConfig, nelson } };
    }),

  setRulesGroup: (group, enabled) =>
    set((s) => {
      if (group === 'westernElectric') {
        return {
          rulesConfig: {
            ...s.rulesConfig,
            westernElectric: { W1: enabled, W2: enabled, W3: enabled, W4: enabled },
          },
        };
      }
      return {
        rulesConfig: {
          ...s.rulesConfig,
          nelson: {
            N1: enabled,
            N2: enabled,
            N3: enabled,
            N4: enabled,
            N5: enabled,
            N6: enabled,
            N7: enabled,
            N8: enabled,
          },
        },
      };
    }),

  setExportOptions: (patch) =>
    set((s) => ({ exportOptions: sanitizeExportOptions({ ...s.exportOptions, ...patch }) })),

  resetPreferences: () =>
    set({
      rulesConfig: defaultToggleConfig(),
      exportOptions: { ...DEFAULT_EXPORT_OPTIONS },
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

/** 读取当前偏好（判异开关 + 导出范围）。 */
export function currentPreferences(): UiPreferences {
  const s = useSettingsStore.getState();
  return { rulesConfig: s.rulesConfig, exportOptions: s.exportOptions };
}

/**
 * 从持久化存储加载偏好。
 *
 * @param persistence 持久化实现（可注入；null 表示不持久化）
 */
export function hydratePreferences(persistence: PreferencesPersistence | null): void {
  if (!persistence) {
    return;
  }
  const loaded = persistence.load();
  if (!loaded) {
    return;
  }
  useSettingsStore.setState({
    rulesConfig: sanitizeRulesConfig(loaded.rulesConfig),
    exportOptions: sanitizeExportOptions(loaded.exportOptions),
  });
}

/**
 * 保存当前偏好到持久化存储。
 *
 * @param persistence 持久化实现
 */
export function persistPreferences(persistence: PreferencesPersistence | null): void {
  if (!persistence) {
    return;
  }
  persistence.save(currentPreferences());
}