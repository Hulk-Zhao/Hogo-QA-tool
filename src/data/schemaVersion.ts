/**
 * Schema 版本号与迁移入口常量。
 *
 * 出处：架构文档 §3.6、§8.5（项目包 JSON 顶层必须含 schemaVersion）。
 */

import { CURRENT_SCHEMA_VERSION } from './schema';

export { CURRENT_SCHEMA_VERSION };
export { migrateProject, validateProject, canMigrate, readSchemaVersion } from './migrations';

/** 支持的 schema 版本列表（升序）。 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

/**
 * 判断给定版本号是否受支持（精确匹配当前支持集）。
 */
export function isSupportedSchemaVersion(version: number): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(version);
}
