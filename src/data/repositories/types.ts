/**
 * ProjectRepository 接口定义（架构文档 §3.7）。
 *
 * 存储介质对上层透明：IdbRepository（首选）/ MemoryRepository（降级）。
 */

import type { Measurement, Project, ProjectSummary } from '../schema';

export type { ProjectSummary };

export interface ProjectRepository {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<Project | null>;
  saveProject(project: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;
  duplicateProject(id: string, newName: string): Promise<Project>;
  // 大数组
  writeMeasurements(ref: string, data: Measurement[]): Promise<void>;
  readMeasurements(ref: string): Promise<Measurement[]>;
  deleteMeasurements(ref: string): Promise<void>;
}

/** 由 Project 计算摘要。 */
export function summarize(project: Project): ProjectSummary {
  let characteristicCount = 0;
  for (const ds of project.datasets) {
    characteristicCount += ds.characteristics.length;
  }
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    datasetCount: project.datasets.length,
    characteristicCount,
  };
}
