/**
 * projectPackage：JSON 项目包导入导出（PRD P0-20）。
 *
 * 单 JSON 文件，含全部实体 + schemaVersion（架构 §8.5）。
 * 导入时先 migrateProject(raw) 做版本兼容与结构校验，不认识的版本
 * 明确报 SCHEMA_VERSION_UNSUPPORTED（硬约束 2）。
 */

import { HogoError } from '../errors';
import { CURRENT_SCHEMA_VERSION, type Project } from '../schema';
import { migrateProject } from '../migrations';
import { validateProject } from '../migrations';
import { genId, nowIso } from '../internal';

/** 项目包顶层结构。 */
export interface ProjectPackage {
  /** 魔数标记，便于识别本工具导出的文件。 */
  format: 'hogo-qa-project';
  schemaVersion: number;
  exportedAt: string;
  project: Project;
}

/**
 * 将项目导出为项目包 JSON 文本。
 *
 * @param project 项目
 * @param pretty 是否美化输出（默认 true，便于人工查看）
 */
export function exportProjectPackage(project: Project, pretty = true): string {
  const pkg: ProjectPackage = {
    format: 'hogo-qa-project',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: nowIso(),
    project: {
      ...project,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
  };
  return pretty ? JSON.stringify(pkg, null, 2) : JSON.stringify(pkg);
}

/**
 * 从项目包 JSON 文本导入项目。
 *
 * 兼容两种形态：
 * 1. 带 format 字段的完整项目包（推荐）。
 * 2. 裸 Project 对象（含 schemaVersion）——直接迁移。
 *
 * @throws {HogoError} IMPORT_PARSE_FAILED（JSON 非法）
 * @throws {HogoError} SCHEMA_VERSION_UNSUPPORTED（版本不支持/缺失）
 */
export function importProjectPackage(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new HogoError('IMPORT_PARSE_FAILED', '项目包 JSON 解析失败，文件可能损坏。', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HogoError('IMPORT_PARSE_FAILED', '项目包顶层必须为对象。', {});
  }
  const obj = parsed as Record<string, unknown>;

  // 优先取内层 project（完整包）；否则视为裸 Project。
  const raw = obj.format === 'hogo-qa-project' && obj.project !== undefined ? obj.project : obj;

  // migrateProject 内含版本校验 + 逐级迁移 + 结构规范化。
  return migrateProject(raw);
}

/**
 * 导入并可选重新分配 id（避免与库中已有项目冲突）。
 *
 * @param text 项目包 JSON 文本
 * @param reassignId true 时生成新项目 id（默认 false，保留原 id）
 */
export function importProjectPackageWithIdOption(
  text: string,
  reassignId: boolean,
): Project {
  const project = importProjectPackage(text);
  if (reassignId) {
    const fresh = validateProject({ ...project, id: genId('proj') } as unknown as Record<string, unknown>);
    return fresh;
  }
  return project;
}

/** 默认项目包文件名。 */
export function defaultPackageFileName(project: Project): string {
  const safe = (project.name || 'project').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  return `${safe}.hogo.json`;
}
