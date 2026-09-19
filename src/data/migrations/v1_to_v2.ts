/**
 * v1 → v2 迁移骨架（首期仅 v1，保留结构以便后续扩展）。
 *
 * 出处：架构文档 §2.5、§8.5。首期 CURRENT_SCHEMA_VERSION=1，
 * 本迁移函数暂不参与主链路，但从 v1 到 v2 的「形状」在此固定：
 * 未来新增字段时，在此补齐默认值，避免旧包导入后字段缺失。
 *
 * 该函数必须是纯函数：输入原始对象（unknown），输出升级后的对象（unknown），
 * 不做校验（校验由 migrations/index.ts 统一处理）。
 */

/**
 * 将 v1 项目对象升级为 v2 形状。
 *
 * 当前 v2 未定义新字段，因此仅规范化顶层缺失的容器字段，
 * 保证结构向后兼容。当 v2 真正引入新字段时在此补充。
 *
 * @param raw v1 原始项目对象
 * @returns 升级后的对象（仍为 unknown，交由统一入口校验）
 */
export function migrateV1ToV2(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...obj };
  // 规范化容器字段，避免旧包缺失导致下游 undefined。
  if (!Array.isArray(next.datasets)) {
    next.datasets = [];
  }
  if (!Array.isArray(next.analysisConfigs)) {
    next.analysisConfigs = [];
  }
  if (!Array.isArray(next.aiUsageLogs)) {
    next.aiUsageLogs = [];
  }
  return next;
}
