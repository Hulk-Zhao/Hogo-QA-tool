/**
 * settingsBootstrap —— 设置持久化的**组合根**（依赖注入的唯一挂载点）。
 *
 * 背景（历史缺陷根因）：`settingsStore` 的 `hydrate*` / `persist*` 定义齐全，
 * 但全库零调用点，且持久化接口无实现类，导致配置「写了从不落盘、启动从不读取」。
 *
 * 分层职责：
 * - 真正的存储实现 `LocalStorageJsonStore` 位于数据层 `browserAdapters.ts`
 *   （数据层唯一允许触碰 localStorage 的文件）；
 * - store 层只依赖注入的窄接口（`SettingsPersistence` / `PreferencesPersistence`），
 *   自身不碰任何浏览器 API；
 * - 本文件属 UI 层（组合根），负责把「数据层实现」注入「store 层消费者」。
 *
 * 两条持久化链路（独立 key，互不拖累）：
 * 1. `hogo-qa-settings`  → AI 配置（Base URL / Key / 模型 / maxTokens / 开关）；
 * 2. `hogo-qa-preferences` → 第五轮 P0 修复新增：判异准则 12 条开关 + 报表导出
 *    范围 7 项勾选。这两项此前是页面级 `useState`，**刷新即丢**，用户明确要求
 *    改走 settingsStore 持久化。
 *
 * 挂载点选择：在 `main.tsx`（应用入口）调用 `bootstrapSettings()`，
 * 而不是在 `App` 组件的 `useEffect` 里 —— 理由：
 *   1. 入口作用域**恰好执行一次**，不受 React 18 StrictMode 开发期
 *      effect 双调用影响，避免「二次挂载把用户刚改的配置又冲刷回旧值」；
 *   2. 在首次渲染**之前**完成 hydrate，首屏即读到已保存配置，无闪烁；
 *   3. 与组件树解耦，热更新 / 组件重挂载不会重复注册订阅。
 *
 * 落盘时机：订阅 store 对应切片变更，**任意来源**（设置页、控制图页、报表页、
 * 清除配置等）的变更都会立即持久化。之所以用「变更即存」而非「手动保存按钮」：
 * 表单是逐字段即时写入 store 的，没有独立保存步骤；把「配置变更」本身当作保存
 * 动作，用户无需记得点击保存，从根本上消除『每次都要重新填写』的复现路径。
 */

import { LocalStorageJsonStore } from '@/data/storage/browserAdapters';
import {
  sanitizeFullDiagnosis,
  type FullDiagnosisRecord,
} from '@/services/ai/diagnosisReport';
import {
  DIAGNOSIS_STORAGE_KEY,
  hydrateDiagnosis,
  persistDiagnosis,
  useDiagnosisStore,
  type DiagnosisPersistence,
} from '@/store/diagnosisStore';
import {
  PREFERENCES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  currentPreferences,
  hydrateAiConfig,
  hydratePreferences,
  persistAiConfig,
  persistPreferences,
  sanitizeAiConfig,
  sanitizeUiPreferences,
  useSettingsStore,
  type AiConfig,
  type PreferencesPersistence,
  type SettingsPersistence,
  type UiPreferences,
} from '@/store/settingsStore';

/** 进程内单例（避免重复构造与重复订阅）。 */
let persistenceSingleton: SettingsPersistence | null = null;

/** 偏好持久化单例。 */
let preferencesSingleton: PreferencesPersistence | null = null;

/** 全面诊断结果持久化单例。 */
let diagnosisSingleton: DiagnosisPersistence | null = null;

/** 订阅是否已注册（保证幂等，避免重复挂载导致多次落盘）。 */
let subscriptionRegistered = false;
let preferencesSubscriptionRegistered = false;
let diagnosisSubscriptionRegistered = false;

/**
 * 获取（并懒创建）AI 配置持久化实现。
 *
 * 返回类型为 store 层的 `SettingsPersistence` 窄接口；具体实现为
 * localStorage 后端（`file://` 与 HTTP 两种形态均可用）。
 *
 * @returns 持久化实现
 */
export function getSettingsPersistence(): SettingsPersistence {
  if (persistenceSingleton === null) {
    persistenceSingleton = new LocalStorageJsonStore<AiConfig>(
      SETTINGS_STORAGE_KEY,
      sanitizeAiConfig,
    );
  }
  return persistenceSingleton;
}

/**
 * 获取（并懒创建）偏好（判异开关 + 导出范围）持久化实现。
 *
 * @returns 偏好持久化实现
 */
export function getPreferencesPersistence(): PreferencesPersistence {
  if (preferencesSingleton === null) {
    preferencesSingleton = new LocalStorageJsonStore<UiPreferences>(
      PREFERENCES_STORAGE_KEY,
      sanitizeUiPreferences,
    );
  }
  return preferencesSingleton;
}

/**
 * 获取（并懒创建）「AI 全面诊断」结果持久化实现。
 *
 * @returns 诊断结果持久化实现
 */
export function getDiagnosisPersistence(): DiagnosisPersistence {
  if (diagnosisSingleton === null) {
    diagnosisSingleton = new LocalStorageJsonStore<FullDiagnosisRecord | null>(
      DIAGNOSIS_STORAGE_KEY,
      sanitizeFullDiagnosis,
    );
  }
  return diagnosisSingleton;
}

/** 显式保存一次当前配置并返回是否成功（供需要即时反馈的调用方复用）。 */
export function saveCurrentAiConfig(): boolean {
  try {
    persistAiConfig(getSettingsPersistence());
    return true;
  } catch (err) {
    // 存储不可用 / 超配额：不阻断 UI，仅告警（避免因持久化失败导致交互崩溃）。
    console.warn('[settings] AI 配置持久化失败：', err);
    return false;
  }
}

/** 显式保存一次当前偏好（判异开关 + 导出范围）。 */
export function saveCurrentPreferences(): boolean {
  try {
    persistPreferences(getPreferencesPersistence());
    return true;
  } catch (err) {
    console.warn('[settings] 偏好持久化失败：', err);
    return false;
  }
}

/**
 * 启动接线：载入已保存的 AI 配置，并订阅后续变更自动落盘。
 *
 * 幂等：多次调用只会注册一次订阅（单例 + 订阅标记）。
 *
 * @returns void
 */
export function bootstrapAiSettings(): void {
  const persistence = getSettingsPersistence();

  // 1) 启动即载入（脏数据由 sanitize + load 容错，绝不抛异常 → 不白屏）。
  hydrateAiConfig(persistence);

  // 2) 变更即落盘（订阅在 hydrate 之后注册，避免刚载入就回写一次）。
  if (!subscriptionRegistered) {
    subscriptionRegistered = true;
    useSettingsStore.subscribe((state, prev) => {
      if (state.aiConfig !== prev.aiConfig) {
        saveCurrentAiConfig();
      }
    });
  }
}

/**
 * 启动接线（偏好）：载入判异准则开关 + 报表导出范围，并订阅变更自动落盘。
 *
 * 幂等：与 `bootstrapAiSettings` 同理，「用户改完开关刷新就丢」这一缺陷
 * 正是本函数要消灭的对象 —— 若把订阅或 hydrate 任一去掉，`settingsBootstrap`
 * 的偏好回归测试必须变红。
 *
 * @returns void
 */
export function bootstrapPreferences(): void {
  const persistence = getPreferencesPersistence();

  hydratePreferences(persistence);

  if (!preferencesSubscriptionRegistered) {
    preferencesSubscriptionRegistered = true;
    useSettingsStore.subscribe((state, prev) => {
      if (
        state.rulesConfig !== prev.rulesConfig ||
        state.exportOptions !== prev.exportOptions
      ) {
        saveCurrentPreferences();
      }
    });
  }
}

/**
 * 启动接线（全面诊断结果）：载入已保存的诊断报告，并订阅变更自动落盘。
 *
 * 需求出处：第五轮 #12「诊断结果持久化（不要 useState）」。若把 hydrate 或订阅
 * 任一去掉，「刷新后诊断报告消失 / 调用 clear 后旧报告复活」的回归测试必须变红。
 *
 * @returns void
 */
export function bootstrapDiagnosis(): void {
  const persistence = getDiagnosisPersistence();

  hydrateDiagnosis(persistence);

  if (!diagnosisSubscriptionRegistered) {
    diagnosisSubscriptionRegistered = true;
    useDiagnosisStore.subscribe((state, prev) => {
      if (state.fullDiagnosis !== prev.fullDiagnosis) {
        try {
          persistDiagnosis(persistence);
        } catch (err) {
          console.warn('[settings] 诊断结果持久化失败：', err);
        }
      }
    });
  }
}

/**
 * 启动接线（总入口）：AI 配置 + 用户偏好。
 *
 * 由 `main.tsx` 在首次渲染前调用。
 *
 * @returns void
 */
export function bootstrapSettings(): void {
  bootstrapAiSettings();
  bootstrapPreferences();
  bootstrapDiagnosis();
}

/** 供测试断言「当前偏好」的快照（等价于 store 内部切片）。 */
export function preferencesSnapshot(): UiPreferences {
  return currentPreferences();
}