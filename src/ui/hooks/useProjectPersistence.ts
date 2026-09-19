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
 */

import { useCallback, useState } from 'react';
import { useProjectStore, buildProjectFromDataset } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { degradationHint } from '@/data/repositories';
import { getSharedRepositoryHandle } from '@/data/repositories/handle';
import { rememberLastProject } from '@/ui/bootstrap/projectSession';
import { HogoError } from '@/data/errors';
import type { Measurement } from '@/data/schema';
import { makeBlobRef } from '@/data/storage/opfsStore';

export interface ProjectPersistenceApi {
  /** 是否正在保存。 */
  saving: boolean;
  /** 最近一次保存时间（ISO）。 */
  lastSavedAt: string | null;
  /** 保存当前项目。 */
  persist: () => Promise<void>;
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
  const dataset = useProjectStore((s) => s.dataset);
  const projectName = useProjectStore((s) => s.projectName);
  const project = useProjectStore((s) => s.project);
  const beginLoading = useUiStore((s) => s.beginLoading);
  const endLoading = useUiStore((s) => s.endLoading);
  const pushToast = useUiStore((s) => s.pushToast);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // 仓库句柄来自全应用共享单例（真实能力探测只做一次，后端选择会话内恒定）。
  const persist = useCallback(async () => {
    setSaving(true);
    beginLoading();
    try {
      if (!dataset) {
        pushToast('暂无数据可保存', 'warning');
        return;
      }
      const handle = await getSharedRepositoryHandle();
      // 进入 `??` 右分支时 project 必为 null，无既有 id 可复用；
      // 与 projectStore.setDataset 的约定一致，统一用 'local' 作为本地项目 id。
      const entity = project ?? buildProjectFromDataset('local', projectName, dataset);

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
      if (hint.length > 0) {
        pushToast(`已保存项目「${projectName}」。${hint}`, 'warning');
      } else {
        pushToast(`已保存项目「${projectName}」`, 'success');
      }
    } catch (err) {
      pushToast(`保存失败：${describeError(err)}`, 'error');
    } finally {
      setSaving(false);
      endLoading();
    }
  }, [dataset, project, projectName, beginLoading, endLoading, pushToast]);

  return { saving, lastSavedAt, persist };
}
