/**
 * useProjectPersistence —— 项目持久化 hook（真实 data 层接入）。
 *
 * 出处：架构文档 §2.8、§5。
 *
 * T02/T03 对接收尾：本 hook 调用真实 `ProjectRepository`
 * （`@/data/repositories` 的 `createRepositoryAsync`）：
 * - 元数据 → `repository.saveProject(project)`（IndexedDB / localStorage 降级）。
 * - 大批量测量值 → `repository.writeMeasurements(ref, data)`（OPFS，不可用时内联）。
 *
 * 能力探测：使用**异步真实探测**（`createRepositoryAsync`，真正 `open()` IndexedDB
 * 并带超时），而非仅检查符号是否存在，避免 `file://` 下 IndexedDB 的假阳性。
 * 仓库句柄在会话内复用，探测只做一次。
 *
 * 保存失败会在 UI 明确 toast（不静默失败）；降级（localStorage / 内存）时附加
 * 面向用户的持久化受限提示（含「改用 start.bat 本地服务」指引）。
 * `saving` / `lastSavedAt` 状态语义保持不变（T03 已验收）。
 *
 * 状态读取口径（本轮 P0 修复）：`persist()` 在**调用时**才从 store 取当前
 * 项目 / 数据集（而非闭包捕获渲染快照），因此「先 `setDataset()`、再同一帧内
 * `persist()`」（导入页的写法）能正确保存，不会误判为「暂无数据」。
 * 返回值表示是否真的落盘成功（失败 / 无数据返回 false，且已 toast 过）。
 */

import { useCallback, useState } from 'react';
import { useProjectStore, buildProjectFromDataset, generateId } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { degradationHint } from '@/data/repositories';
import { getSharedRepositoryHandle } from '@/data/repositories/handle';
import { rememberLastProject } from '@/ui/bootstrap/projectSession';
import { HogoError } from '@/data/errors';
import type { Measurement } from '@/data/schema';
import { makeBlobRef } from '@/data/storage/opfsStore';

/** 保存选项。 */
export interface PersistOptions {
  /**
   * 覆盖成功提示文案。
   *
   * 导入页用它把「导入成功」与「已保存」合并成一句话，避免同一动作弹两条
   * 重复的成功提示（提示条数归本 hook 统一管理，页面不重复提示）。
   */
  successMessage?: string;
}

export interface ProjectPersistenceApi {
  /** 是否正在保存。 */
  saving: boolean;
  /** 最近一次保存时间（ISO）。 */
  lastSavedAt: string | null;
  /**
   * 保存当前项目。
   *
   * @param options 保存选项
   * @returns 是否真的落盘成功（失败时已 toast，调用方无需重复提示）
   */
  persist: (options?: PersistOptions) => Promise<boolean>;
}

/** 把 HogoError / 普通 Error 转为可读提示。 */
function describeError(err: unknown): string {
  if (err instanceof HogoError) {
    return `${err.message}（${err.code}）`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 提供项目持久化 API。
 *
 * @returns 持久化 API
 */
export function useProjectPersistence(): ProjectPersistenceApi {
  const beginLoading = useUiStore((s) => s.beginLoading);
  const endLoading = useUiStore((s) => s.endLoading);
  const pushToast = useUiStore((s) => s.pushToast);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // 仓库句柄来自全应用共享单例（真实能力探测只做一次，后端选择会话内恒定）。
  const persist = useCallback(async (options?: PersistOptions): Promise<boolean> => {
    setSaving(true);
    beginLoading();
    try {
      // **实时读取 store**，而不是闭包捕获渲染时的快照：导入页在 `setDataset`
      // 之后**同一帧内**就调用本方法，闭包里的 dataset 仍是导入前的 null ——
      // 会直接走「暂无数据可保存」并静默不落盘。这是「导入后项目库为空」的
      // 另一半原因（见记忆第二十一节）。
      const { dataset, project, projectName } = useProjectStore.getState();
      if (!dataset) {
        pushToast('暂无数据可保存', 'warning');
        return false;
      }
      const handle = await getSharedRepositoryHandle();
      // 正常路径下 `setDataset` 已建好项目实体（id 唯一），右分支仅作防御。
      const entity = project ?? buildProjectFromDataset(generateId('proj'), projectName, dataset);

      // 先写大批量测量值（OPFS 优先，不可用时内联），再写项目元数据。
      const characteristics = await Promise.all(
        entity.datasets[0]?.characteristics.map(async (c) => {
          const measurements: Measurement[] = c.measurements;
          if (measurements.length === 0) {
            return { ...c, measurementBlobRef: null };
          }
          const ref = c.measurementBlobRef ?? makeBlobRef(c.id);
          await handle.repository.writeMeasurements(ref, measurements);
          return { ...c, measurementBlobRef: ref };
        }) ?? [],
      );

      const persisted = {
        ...entity,
        name: projectName,
        updatedAt: new Date().toISOString(),
        datasets:
          entity.datasets.length > 0
            ? [{ ...entity.datasets[0], characteristics }, ...entity.datasets.slice(1)]
            : entity.datasets,
      };

      await handle.repository.saveProject(persisted);
      // 只有真正落盘成功才记「上次项目」：刷新后据此自动恢复数据集。
      rememberLastProject(persisted.id);
      setLastSavedAt(persisted.updatedAt);
      const hint = degradationHint(handle);
      const base = options?.successMessage ?? `已保存项目「${projectName}」`;
      pushToast(hint.length > 0 ? `${base}。${hint}` : base, hint.length > 0 ? 'warning' : 'success');
      return true;
    } catch (err) {
      pushToast(`保存失败：${describeError(err)}`, 'error');
      return false;
    } finally {
      setSaving(false);
      endLoading();
    }
  }, [beginLoading, endLoading, pushToast]);

  return { saving, lastSavedAt, persist };
}
