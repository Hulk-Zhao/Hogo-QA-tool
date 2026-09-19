/**
 * projectSession —— 项目会话恢复 + AI 审计落盘（UI 层组合根）。
 *
 * 出处（本轮 P1 优化）：
 * 1. **项目数据刷新即空**：`bootstrapSettings()` 只恢复了 AI 配置 / 偏好 /
 *    诊断结果，**不恢复上次打开的项目**。用户「导入 → 保存 → 刷新」后
 *    `projectStore.dataset` 为空，报表页显示「尚无可导出的数据」，
 *    必须手动去项目库重新打开一次 —— 数据没丢，但体验等同于丢了。
 * 2. **AI 审计随会话蒸发**：审计记录只活在 `projectStore` 内存切片里，
 *    刷新即清空，PRD P0-24 的「每次请求可审计」跨会话不可验证。
 *
 * 设计要点（与既有 bootstrap* 一致的分层口径）：
 * - 真正的存储实现 `LocalStorageJsonStore` 在数据层 `browserAdapters`；
 * - store 层只依赖注入的窄接口；
 * - 本文件属 UI 层组合根，负责把两者接起来。
 *
 * 两条独立持久化链路（各用各的 key，互不拖累）：
 * - `hogo-qa-last-project`   → 上次成功保存 / 打开的项目 id；
 * - `hogo-qa-ai-usage-logs`  → AI 调用审计记录（只增不减，上限见 MAX_AI_USAGE_LOGS）。
 *
 * 容错立场（必须）：`file://` 离线双击包下 IndexedDB 不可用、localStorage 也
 * 可能被禁用 —— 恢复失败必须**静默降级**（不报错、不白屏、不影响手动流程），
 * 这与「保存」路径的显式 toast 提示是两件事。
 */

import { LocalStorageJsonStore } from '@/data/storage/browserAdapters';
import { getSharedRepositoryHandle } from '@/data/repositories/handle';
import type { ProjectRepository } from '@/data/repositories/types';
import {
  AI_USAGE_LOG_STORAGE_KEY,
  hydrateAiUsageLogs,
  persistAiUsageLogs,
  sanitizeAiUsageLogs,
  useProjectStore,
  type AiUsageLogPersistence,
} from '@/store/projectStore';
import type { AiUsageEntry } from '@/services/ai/usageLog';

/** 「上次项目」持久化 key。 */
export const LAST_PROJECT_STORAGE_KEY = 'hogo-qa-last-project';

/** 上次打开 / 保存的项目记录。 */
export interface LastProjectRecord {
  /** 项目 id（与 `ProjectRepository.getProject` 的键一致）。 */
  projectId: string;
  /** 记录时间（ISO 8601，仅供排障展示）。 */
  openedAt: string;
}

/** 「上次项目」持久化窄接口（含主动擦除）。 */
export interface LastProjectPersistence {
  load: () => LastProjectRecord | null;
  save: (record: LastProjectRecord) => void;
  clear: () => void;
}

/**
 * 容错归一化「上次项目」记录。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法记录；非对象 / projectId 缺失时返回 null（视为无记录）
 */
export function sanitizeLastProject(raw: unknown): LastProjectRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string' || r.projectId.length === 0) {
    return null;
  }
  return {
    projectId: r.projectId,
    openedAt: typeof r.openedAt === 'string' ? r.openedAt : '',
  };
}

let lastProjectSingleton: LastProjectPersistence | null = null;
let aiUsageLogSingleton: AiUsageLogPersistence | null = null;
let aiUsageLogSubscriptionRegistered = false;

/**
 * 获取（并懒创建）「上次项目」持久化实现。
 *
 * @returns 持久化实现
 */
export function getLastProjectPersistence(): LastProjectPersistence {
  if (lastProjectSingleton === null) {
    lastProjectSingleton = new LocalStorageJsonStore<LastProjectRecord>(
      LAST_PROJECT_STORAGE_KEY,
      sanitizeLastProject,
    );
  }
  return lastProjectSingleton;
}

/**
 * 获取（并懒创建）AI 审计记录持久化实现。
 *
 * @returns 持久化实现
 */
export function getAiUsageLogPersistence(): AiUsageLogPersistence {
  if (aiUsageLogSingleton === null) {
    aiUsageLogSingleton = new LocalStorageJsonStore<AiUsageEntry[]>(
      AI_USAGE_LOG_STORAGE_KEY,
      sanitizeAiUsageLogs,
    );
  }
  return aiUsageLogSingleton;
}

/**
 * 记住「上次项目」。
 *
 * 调用时机：**保存成功之后**（`useProjectPersistence.persist`）与
 * **打开项目之后**（项目库 `openProject`）。只在真正有持久化实体时才记录，
 * 避免把「仅存在于内存、从未落盘」的项目 id 写成恢复目标（刷新后必然指向
 * 不存在的项目，白白多一次无效查询）。
 *
 * @param projectId 项目 id
 * @returns void
 */
export function rememberLastProject(projectId: string): void {
  try {
    getLastProjectPersistence().save({ projectId, openedAt: new Date().toISOString() });
  } catch (err) {
    // 存储不可用 / 超配额：不影响保存主流程（项目本身已落盘，只是少了自动恢复）。
    console.warn('[project] 记录「上次项目」失败（已忽略）：', err);
  }
}

/**
 * 忘记「上次项目」。默认无条件清除；传入 id 时仅在 id 匹配时清除
 * （用于项目库删除：删的不是当前恢复目标就不该动它）。
 *
 * @param projectId 可选的项目 id
 * @returns void
 */
export function forgetLastProject(projectId?: string): void {
  const persistence = getLastProjectPersistence();
  try {
    if (typeof projectId === 'string') {
      const current = persistence.load();
      if (current === null || current.projectId !== projectId) {
        return;
      }
    }
    persistence.clear();
  } catch (err) {
    console.warn('[project] 清除「上次项目」失败（已忽略）：', err);
  }
}

/** 恢复依赖注入点（测试可覆盖，避免触碰 IndexedDB）。 */
export interface RestoreLastProjectDeps {
  /** 注入的仓库；缺省走全应用共享句柄。 */
  repository?: ProjectRepository;
}

/**
 * 恢复上次项目（异步、可注入、绝不抛异常）。
 *
 * 竞态处理：恢复是异步的，用户完全可能在恢复完成前手动导入 / 打开项目。
 * 因此**每次改动 store 之前都重新检查** `project === null`，
 * 保证「用户手动操作」永远优先，自动恢复只填空档。
 *
 * 自愈：目标项目已不存在（被删除 / 存储被清理）时，顺手清掉记录，
 * 避免每次启动都做一次无效查询。
 *
 * @param deps 依赖注入
 * @returns 是否真的恢复了项目（供测试断言）
 */
export async function restoreLastProject(deps: RestoreLastProjectDeps = {}): Promise<boolean> {
  if (useProjectStore.getState().project !== null) {
    return false;
  }
  const record = getLastProjectPersistence().load();
  if (record === null) {
    return false;
  }
  try {
    const repository = deps.repository ?? (await getSharedRepositoryHandle()).repository;
    if (useProjectStore.getState().project !== null) {
      return false;
    }
    const project = await repository.getProject(record.projectId);
    if (project === null) {
      // 目标已不存在：清掉记录，下次启动不再空跑。
      getLastProjectPersistence().clear();
      return false;
    }
    if (useProjectStore.getState().project !== null) {
      return false;
    }
    useProjectStore.getState().setProject(project);
    return true;
  } catch (err) {
    // 降级环境（IndexedDB 不可用等）：静默失败，用户仍可手动导入 / 打开。
    console.warn('[project] 上次项目自动恢复失败（已忽略）：', err);
    return false;
  }
}

/**
 * 启动接线（项目会话）：异步恢复上次项目。
 *
 * 幂等：恢复本身是「填空」语义（project 非空即直接返回），重复调用无副作用。
 * 之所以不注册订阅：记录写入点只有「保存成功」与「打开成功」两处，
 * 由调用方显式调用 `rememberLastProject` 更精确（见其注释）。
 *
 * @param deps 依赖注入（测试用）
 * @returns void
 */
export function bootstrapProjectSession(deps: RestoreLastProjectDeps = {}): void {
  void restoreLastProject(deps);
}

/**
 * 启动接线（AI 审计）：载入审计记录，并订阅后续变更自动落盘。
 *
 * 证伪立场：若去掉 hydrate 或订阅，`aiUsageLogPersistence.spec` 的
 * 「变更即落盘 / 重开模块后还原」断言必须变红。
 *
 * @returns void
 */
export function bootstrapAiUsageLogs(): void {
  const persistence = getAiUsageLogPersistence();

  hydrateAiUsageLogs(persistence);

  if (!aiUsageLogSubscriptionRegistered) {
    aiUsageLogSubscriptionRegistered = true;
    useProjectStore.subscribe((state, prev) => {
      if (state.aiUsageLogs !== prev.aiUsageLogs) {
        try {
          persistAiUsageLogs(persistence);
        } catch (err) {
          console.warn('[project] AI 审计记录持久化失败（已忽略）：', err);
        }
      }
    });
  }
}
