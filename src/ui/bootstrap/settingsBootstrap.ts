/**
 * settingsBootstrap —— AI 配置持久化的**组合根**（依赖注入的唯一挂载点）。
 *
 * 背景（本轮缺陷根因）：`settingsStore` 的 `hydrateAiConfig` / `persistAiConfig`
 * 定义齐全，但全库零调用点，且 `SettingsPersistence` 接口无实现类，
 * 导致 AI 配置「写了从不落盘、启动从不读取」。
 *
 * 分层职责：
 * - 真正的存储实现 `LocalStorageJsonStore` 位于数据层 `browserAdapters.ts`
 *   （数据层唯一允许触碰 localStorage 的文件）；
 * - store 层只依赖注入的窄接口 `SettingsPersistence`，自身不碰任何浏览器 API；
 * - 本文件属 UI 层（组合根），负责把「数据层实现」注入「store 层消费者」。
 *
 * 挂载点选择：在 `main.tsx`（应用入口）调用 `bootstrapAiSettings()`，
 * 而不是在 `App` 组件的 `useEffect` 里 —— 理由：
 *   1. 入口作用域**恰好执行一次**，不受 React 18 StrictMode 开发期
 *      effect 双调用影响，避免「二次挂载把用户刚改的配置又冲刷回旧值」；
 *   2. 在首次渲染**之前**完成 hydrate，首屏即读到已保存配置，无闪烁；
 *   3. 与组件树解耦，热更新 / 组件重挂载不会重复注册订阅。
 *
 * 落盘时机：订阅 `settingsStore.aiConfig` 变更，**任意来源**（设置页输入、
 * 清除配置等）的配置变更都会立即持久化。之所以用「变更即存」而非「手动保存按钮」：
 * 设置表单是逐字段即时写入 store 的，没有独立保存步骤；把「配置变更」本身
 * 当作保存动作，用户无需记得点击保存，从根本上消除『每次都要重新填写』的复现路径。
 */

import { LocalStorageJsonStore } from '@/data/storage/browserAdapters';
import {
  SETTINGS_STORAGE_KEY,
  hydrateAiConfig,
  persistAiConfig,
  sanitizeAiConfig,
  useSettingsStore,
  type AiConfig,
  type SettingsPersistence,
} from '@/store/settingsStore';

/** 进程内单例（避免重复构造与重复订阅）。 */
let persistenceSingleton: SettingsPersistence | null = null;

/** 订阅是否已注册（保证幂等，避免重复挂载导致多次落盘）。 */
let subscriptionRegistered = false;

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

/**
 * 启动接线：载入已保存配置，并订阅后续变更自动落盘。
 *
 * 幂等：多次调用只会注册一次订阅（单例 + 订阅标记）。
 * 由 `main.tsx` 在首次渲染前调用。
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
