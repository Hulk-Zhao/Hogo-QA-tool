/**
 * MemoryRepository：内存版项目仓库（降级 + 测试用）。
 *
 * 出处：架构文档 §0.1、§7.4。IndexedDB 不可用时兜底，会话内有效；
 * 大数组写入内存 Map（模拟 OPFS 引用）。
 */

import { HogoError } from '../errors';
import type { Measurement, Project } from '../schema';
import type { ProjectRepository, ProjectSummary } from './types';
import { summarize } from './types';
import { genId } from '../internal';

/** 深拷贝工具（与内存适配器保持一致的序列化语义）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class MemoryRepository implements ProjectRepository {
  /** 项目元数据：id → Project。 */
  private readonly projects: Map<string, Project> = new Map<string, Project>();
  /** 大数组：ref → Measurement[]。 */
  private readonly measurements: Map<string, Measurement[]> = new Map<string, Measurement[]>();

  async listProjects(): Promise<ProjectSummary[]> {
    const list = Array.from(this.projects.values()).map((p) => summarize(p));
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return list.map((s) => clone(s));
  }

  async getProject(id: string): Promise<Project | null> {
    const p = this.projects.get(id);
    return p ? clone(p) : null;
  }

  async saveProject(project: Project): Promise<void> {
    if (!project || typeof project.id !== 'string' || project.id.length === 0) {
      throw new HogoError('STORAGE_UNAVAILABLE', '保存项目失败：project.id 缺失。', { project });
    }
    this.projects.set(project.id, clone(project));
  }

  async deleteProject(id: string): Promise<void> {
    const p = this.projects.get(id);
    if (p) {
      // 级联删除该项目下所有特性的大数组引用。
      const refs = collectBlobRefs(p);
      for (const ref of refs) {
        this.measurements.delete(ref);
      }
    }
    this.projects.delete(id);
  }

  async duplicateProject(id: string, newName: string): Promise<Project> {
    const src = this.projects.get(id);
    if (!src) {
      throw new HogoError('STORAGE_UNAVAILABLE', `复制失败：项目不存在 ${id}。`, { id });
    }
    const copy: Project = clone(src);
    copy.id = genId('proj');
    copy.name = newName;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    // 重新分配实体 id 并迁移大数组引用。
    remapProjectIds(copy, this.measurements);
    this.projects.set(copy.id, clone(copy));
    return clone(copy);
  }

  async writeMeasurements(ref: string, data: Measurement[]): Promise<void> {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new HogoError('STORAGE_UNAVAILABLE', 'writeMeasurements：ref 缺失。', { ref });
    }
    this.measurements.set(ref, clone(data));
  }

  async readMeasurements(ref: string): Promise<Measurement[]> {
    const v = this.measurements.get(ref);
    return v ? clone(v) : [];
  }

  async deleteMeasurements(ref: string): Promise<void> {
    this.measurements.delete(ref);
  }

  /** 测试辅助：清空。 */
  clear(): void {
    this.projects.clear();
    this.measurements.clear();
  }
}

/** 收集项目下所有 measureBlobRef。 */
function collectBlobRefs(project: Project): string[] {
  const refs: string[] = [];
  for (const ds of project.datasets) {
    for (const c of ds.characteristics) {
      if (c.measurementBlobRef) {
        refs.push(c.measurementBlobRef);
      }
    }
  }
  return refs;
}

/**
 * 深拷贝项目并重新分配 id（用于 duplicate）。
 * 大数组在内存仓库中以 ref 存储，这里同步复制一份到新 ref。
 */
function remapProjectIds(project: Project, store: Map<string, Measurement[]>): void {
  for (const ds of project.datasets) {
    ds.id = genId('ds');
    ds.projectId = project.id;
    for (const c of ds.characteristics) {
      c.id = genId('char');
      c.datasetId = ds.id;
      const oldRef = c.measurementBlobRef;
      if (oldRef) {
        const newRef = `mem_${genId('mref')}`;
        c.measurementBlobRef = newRef;
        const existing = store.get(oldRef);
        if (existing) {
          store.set(newRef, clone(existing));
        }
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
  for (const cfg of project.analysisConfigs) {
    cfg.id = genId('cfg');
    cfg.projectId = project.id;
  }
  for (const log of project.aiUsageLogs) {
    log.id = genId('log');
    log.projectId = project.id;
  }
}
