/**
 * IdbRepository：基于 IndexedDB + OPFS 的项目仓库（首选实现）。
 *
 * 存储策略（架构文档 §7.4）：
 * - 项目元数据（含小数组、规格限、配置）→ IndexedDB `projects` store。
 * - 大批量测量值 → 优先 OPFS 文件（key = measurementBlobRef）；
 *   OPFS 不可用（未注入 FileStore 或写入失败）时内联进 IndexedDB
 *   `measurements` store（key = measurementBlobRef，值含 values 数组）。
 *
 * 关键：所有底层访问通过注入的 KeyValueStore / FileStore 完成，
 * 业务逻辑不直接引用 `indexedDB` / `navigator`（便于 Node 测试）。
 */

import { HogoError } from '../errors';
import type { Measurement, Project } from '../schema';
import type { FileStore, KeyValueStore } from '../storage/adapters';
import { summarize } from './types';
import type { ProjectRepository, ProjectSummary } from './types';
import { genId, nowIso } from '../internal';

/** IndexedDB 中内联测量值记录的形状。 */
interface InlineMeasurementRecord {
  characteristicId: string;
  values: number[];
}

export interface IdbRepositoryOptions {
  /** 键值仓库（IndexedDB 抽象）。 */
  keyValue: KeyValueStore;
  /** 文件仓库（OPFS 抽象）；未提供则所有测量值内联。 */
  fileStore?: FileStore;
}

export class IdbRepository implements ProjectRepository {
  private readonly kv: KeyValueStore;
  private readonly fs: FileStore | undefined;

  constructor(options: IdbRepositoryOptions) {
    this.kv = options.keyValue;
    this.fs = options.fileStore;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const all = await this.kv.getAll<Project>('projects');
    const list = all.map((p) => summarize(p));
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return list;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.kv.get<Project>('projects', id);
  }

  async saveProject(project: Project): Promise<void> {
    if (!project || typeof project.id !== 'string' || project.id.length === 0) {
      throw new HogoError('STORAGE_UNAVAILABLE', '保存项目失败：project.id 缺失。', { project });
    }
    await this.kv.put<Project>('projects', project.id, project);
  }

  async deleteProject(id: string): Promise<void> {
    const p = await this.getProject(id);
    if (p) {
      for (const ds of p.datasets) {
        for (const c of ds.characteristics) {
          if (c.measurementBlobRef) {
            await this.deleteMeasurements(c.measurementBlobRef);
          }
        }
      }
    }
    await this.kv.delete('projects', id);
  }

  async duplicateProject(id: string, newName: string): Promise<Project> {
    const src = await this.getProject(id);
    if (!src) {
      throw new HogoError('STORAGE_UNAVAILABLE', `复制失败：项目不存在 ${id}。`, { id });
    }
    const copy: Project = JSON.parse(JSON.stringify(src)) as Project;
    copy.id = genId('proj');
    copy.name = newName;
    copy.createdAt = nowIso();
    copy.updatedAt = copy.createdAt;

    for (const ds of copy.datasets) {
      ds.id = genId('ds');
      ds.projectId = copy.id;
      for (const c of ds.characteristics) {
        const oldRef = c.measurementBlobRef;
        c.id = genId('char');
        c.datasetId = ds.id;
        if (oldRef) {
          // 取出旧测量值（OPFS 或内联），复制到新 ref。
          const values = await this.readRawMeasurements(oldRef);
          const newRef = `meas_${c.id}.json`;
          await this.writeRawMeasurements(newRef, values, c.id);
          c.measurementBlobRef = newRef;
        }
        for (const m of c.measurements) {
          m.id = genId('meas');
          m.characteristicId = c.id;
        }
      }
      for (const d of ds.defectRecords) {
        d.id = genId('def');
        d.datasetId = ds.id;
      }
    }
    for (const cfg of copy.analysisConfigs) {
      cfg.id = genId('cfg');
      cfg.projectId = copy.id;
    }
    for (const lg of copy.aiUsageLogs) {
      lg.id = genId('log');
      lg.projectId = copy.id;
    }
    await this.saveProject(copy);
    return copy;
  }

  async writeMeasurements(ref: string, data: Measurement[]): Promise<void> {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new HogoError('STORAGE_UNAVAILABLE', 'writeMeasurements：ref 缺失。', { ref });
    }
    const values = data.map((m) => m.value);
    const characteristicId = data.length > 0 ? data[0].characteristicId : '';
    await this.writeRawMeasurements(ref, values, characteristicId);
  }

  async readMeasurements(ref: string): Promise<Measurement[]> {
    const values = await this.readRawMeasurements(ref);
    return values.map((value, i) => ({
      id: `${ref}#${i}`,
      characteristicId: '',
      value,
      subgroupId: null,
      timestamp: null,
      batch: null,
      excluded: false,
      excludeReason: null,
    }));
  }

  async deleteMeasurements(ref: string): Promise<void> {
    if (this.fs) {
      await this.fs.delete(ref);
    }
    await this.kv.delete('measurements', ref);
  }

  // -------------------------------------------------------------------------
  // 内部：OPFS 优先，其次内联 IndexedDB
  // -------------------------------------------------------------------------

  private async writeRawMeasurements(
    ref: string,
    values: number[],
    characteristicId: string,
  ): Promise<void> {
    if (this.fs) {
      try {
        await this.fs.writeText(ref, JSON.stringify(values));
        return;
      } catch {
        // OPFS 写入失败 → 降级内联，不阻断保存（架构 §7.4）。
      }
    }
    const rec: InlineMeasurementRecord = { characteristicId, values };
    await this.kv.put<InlineMeasurementRecord>('measurements', ref, rec);
  }

  private async readRawMeasurements(ref: string): Promise<number[]> {
    if (this.fs) {
      const text = await this.fs.readText(ref);
      if (text !== null) {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((v) => Number(v));
        }
      }
    }
    const rec = await this.kv.get<InlineMeasurementRecord>('measurements', ref);
    if (!rec) {
      return [];
    }
    return rec.values.map((v) => Number(v));
  }
}
