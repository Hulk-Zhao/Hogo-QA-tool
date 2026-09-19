/**
 * migrateProject：项目包版本迁移统一入口。
 *
 * 出处：架构文档 §2.5、§8.5、硬约束 2（schemaVersion 迁移必须实现）。
 *
 * 规则：
 * 1. 读出 raw.schemaVersion（缺失视为非法/未知版本）。
 * 2. 若版本号 > CURRENT_SCHEMA_VERSION：明确报 SCHEMA_VERSION_UNSUPPORTED。
 * 3. 若版本号 < CURRENT_SCHEMA_VERSION：按顺序调用迁移函数逐级升级。
 * 4. 若版本号不在已实现迁移链上：报 SCHEMA_VERSION_UNSUPPORTED（不静默失败）。
 * 5. 迁移完成后做结构校验（validateProject），确保实体完整性。
 *
 * 迁移链（当前）：v1 → v2 → ... 迭代升级到 CURRENT_SCHEMA_VERSION。
 * 首期 CURRENT_SCHEMA_VERSION=1，迁移链为空，仅做 v1 校验。
 */

import { HogoError } from '../errors';
import type { AnalysisConfig, Dataset, Project } from '../schema';
import { CURRENT_SCHEMA_VERSION } from '../schema';
import { migrateV1ToV2 } from './v1_to_v2';

/** 迁移函数签名：把 version 版对象升级为 version+1 版对象。 */
type MigrationFn = (raw: unknown) => unknown;

/**
 * 迁移链：key 为「源版本号」，值为升级到「源版本号 + 1」的函数。
 * 例：MIGRATIONS[1] 把 v1 升级到 v2。
 *
 * 首期 v1 为当前版本，暂无需要执行的迁移；v1_to_v2 已登记，
 * 待 v2 正式发布时把 CURRENT_SCHEMA_VERSION 提升并启用该链即可。
 */
const MIGRATIONS: Record<number, MigrationFn> = {
  1: migrateV1ToV2,
};

/**
 * 判断某版本号是否存在迁移路径通往 CURRENT_SCHEMA_VERSION。
 */
export function canMigrate(fromVersion: number): boolean {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    return false;
  }
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return true;
  }
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return false;
  }
  let v = fromVersion;
  while (v < CURRENT_SCHEMA_VERSION) {
    if (!MIGRATIONS[v]) {
      return false;
    }
    v += 1;
  }
  return true;
}

/**
 * 读取原始对象中的 schemaVersion。
 *
 * @throws {HogoError} SCHEMA_VERSION_UNSUPPORTED（缺失或非法）
 */
export function readSchemaVersion(raw: unknown): number {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HogoError('SCHEMA_VERSION_UNSUPPORTED', '项目包结构非法：顶层不是对象。', { raw });
  }
  const v = (raw as Record<string, unknown>).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new HogoError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `项目包缺少合法的 schemaVersion（收到 ${JSON.stringify(v)}）。`,
      { schemaVersion: v },
    );
  }
  return v;
}

/**
 * 逐级迁移到当前版本。
 *
 * @throws {HogoError} SCHEMA_VERSION_UNSUPPORTED（版本过高或迁移链断裂）
 */
export function migrateProject(raw: unknown): Project {
  const fromVersion = readSchemaVersion(raw);

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new HogoError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `项目包版本 ${fromVersion} 高于当前工具支持的版本 ${CURRENT_SCHEMA_VERSION}，请升级工具。`,
      { fromVersion, current: CURRENT_SCHEMA_VERSION },
    );
  }

  if (!canMigrate(fromVersion)) {
    throw new HogoError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `不存在从版本 ${fromVersion} 到 ${CURRENT_SCHEMA_VERSION} 的迁移路径。`,
      { fromVersion, current: CURRENT_SCHEMA_VERSION },
    );
  }

  let current: unknown = raw;
  let v = fromVersion;
  while (v < CURRENT_SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) {
      throw new HogoError(
        'SCHEMA_VERSION_UNSUPPORTED',
        `迁移链在版本 ${v} → ${v + 1} 处断裂。`,
        { at: v },
      );
    }
    current = fn(current);
    v += 1;
  }

  const obj = current as Record<string, unknown>;
  // 迁移后写入当前版本号。
  obj.schemaVersion = CURRENT_SCHEMA_VERSION;

  return validateProject(obj);
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/**
 * 校验并规范化项目结构，返回强类型 Project。
 *
 * @throws {HogoError} SCHEMA_VERSION_UNSUPPORTED（结构不可修复）
 */
export function validateProject(raw: Record<string, unknown>): Project {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id.length === 0) {
    throw new HogoError('SCHEMA_VERSION_UNSUPPORTED', '项目缺少 id，无法导入。', { raw });
  }

  const datasets: Dataset[] = asArray(raw.datasets).map((d) => normalizeDataset(d));
  const analysisConfigs: AnalysisConfig[] = asArray(raw.analysisConfigs).map((c) =>
    normalizeAnalysisConfig(c),
  );

  const project: Project = {
    id,
    name: typeof raw.name === 'string' ? raw.name : '未命名项目',
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets,
    analysisConfigs,
    aiUsageLogs: asArray(raw.aiUsageLogs).map((l) => normalizeAiUsageLog(l)),
  };
  return project;
}

function normalizeDataset(raw: unknown): Dataset {
  const o = isObj(raw) ? raw : {};
  return {
    id: typeof o.id === 'string' ? o.id : '',
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    name: typeof o.name === 'string' ? o.name : '',
    sourceType:
      o.sourceType === 'xlsx' || o.sourceType === 'csv' || o.sourceType === 'json'
        ? o.sourceType
        : 'json',
    importedAt: typeof o.importedAt === 'string' ? o.importedAt : new Date().toISOString(),
    rawFileName: typeof o.rawFileName === 'string' ? o.rawFileName : '',
    characteristics: asArray(o.characteristics).map((c) => normalizeCharacteristic(c)),
    defectRecords: asArray(o.defectRecords).map((d) => normalizeDefectRecord(d)),
  };
}

function normalizeCharacteristic(raw: unknown): Dataset['characteristics'][number] {
  const o = isObj(raw) ? raw : {};
  const spec = isObj(o.specLimits) ? o.specLimits : {};
  return {
    id: typeof o.id === 'string' ? o.id : '',
    datasetId: typeof o.datasetId === 'string' ? o.datasetId : '',
    name: typeof o.name === 'string' ? o.name : '',
    specLimits: {
      usl: typeof spec.usl === 'number' ? spec.usl : null,
      lsl: typeof spec.lsl === 'number' ? spec.lsl : null,
      target: typeof spec.target === 'number' ? spec.target : null,
      unit: typeof spec.unit === 'string' ? spec.unit : '',
    },
    measurements: asArray(o.measurements).map((m) => normalizeMeasurement(m)),
    subgroups: asArray(o.subgroups).map((s) => normalizeSubgroup(s)),
    nullCount: typeof o.nullCount === 'number' ? o.nullCount : 0,
    outlierFlags: asArray(o.outlierFlags).map((f) => normalizeOutlierFlag(f)),
    preprocessConfigRef: typeof o.preprocessConfigRef === 'string' ? o.preprocessConfigRef : null,
    measurementBlobRef: typeof o.measurementBlobRef === 'string' ? o.measurementBlobRef : null,
  };
}

function normalizeMeasurement(raw: unknown): Dataset['characteristics'][number]['measurements'][number] {
  const o = isObj(raw) ? raw : {};
  return {
    id: typeof o.id === 'string' ? o.id : '',
    characteristicId: typeof o.characteristicId === 'string' ? o.characteristicId : '',
    value: typeof o.value === 'number' ? o.value : Number(o.value),
    subgroupId: typeof o.subgroupId === 'string' ? o.subgroupId : null,
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    batch: typeof o.batch === 'string' ? o.batch : null,
    excluded: o.excluded === true,
    excludeReason: typeof o.excludeReason === 'string' ? o.excludeReason : null,
  };
}

function normalizeSubgroup(raw: unknown): Dataset['characteristics'][number]['subgroups'][number] {
  const o = isObj(raw) ? raw : {};
  return {
    id: typeof o.id === 'string' ? o.id : '',
    characteristicId: typeof o.characteristicId === 'string' ? o.characteristicId : '',
    index: typeof o.index === 'number' ? o.index : 0,
    size: typeof o.size === 'number' ? o.size : 0,
    measurementIds: asArray(o.measurementIds).map((x) => String(x)),
    mean: typeof o.mean === 'number' ? o.mean : 0,
    range: typeof o.range === 'number' ? o.range : 0,
    std: typeof o.std === 'number' ? o.std : 0,
  };
}

function normalizeOutlierFlag(raw: unknown): Dataset['characteristics'][number]['outlierFlags'][number] {
  const o = isObj(raw) ? raw : {};
  return {
    measurementId: typeof o.measurementId === 'string' ? o.measurementId : '',
    method: o.method === 'iqr' ? 'iqr' : 'grubbs',
    statistic: typeof o.statistic === 'number' ? o.statistic : 0,
    threshold: typeof o.threshold === 'number' ? o.threshold : 0,
    confirmed: o.confirmed === true,
  };
}

function normalizeDefectRecord(raw: unknown): Dataset['defectRecords'][number] {
  const o = isObj(raw) ? raw : {};
  return {
    id: typeof o.id === 'string' ? o.id : '',
    datasetId: typeof o.datasetId === 'string' ? o.datasetId : '',
    defectType: typeof o.defectType === 'string' ? o.defectType : '',
    count: typeof o.count === 'number' ? o.count : Number(o.count) || 0,
    category: typeof o.category === 'string' ? o.category : null,
  };
}

const WE_KEYS = ['W1', 'W2', 'W3', 'W4'] as const;
const NELSON_KEYS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'] as const;

function normalizeAnalysisConfig(raw: unknown): AnalysisConfig {
  const o = isObj(raw) ? raw : {};
  const weRaw = isObj(o.weRules) ? o.weRules : {};
  const nelRaw = isObj(o.nelsonRules) ? o.nelsonRules : {};
  const weRules = {} as Record<(typeof WE_KEYS)[number], boolean>;
  const nelsonRules = {} as Record<(typeof NELSON_KEYS)[number], boolean>;
  for (const k of WE_KEYS) {
    weRules[k] = weRaw[k] !== false;
  }
  for (const k of NELSON_KEYS) {
    nelsonRules[k] = nelRaw[k] !== false;
  }
  return {
    id: typeof o.id === 'string' ? o.id : '',
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    name: typeof o.name === 'string' ? o.name : '默认配置',
    subgroupCapacity: typeof o.subgroupCapacity === 'number' ? o.subgroupCapacity : 5,
    subgroupMode:
      o.subgroupMode === 'byColumn' || o.subgroupMode === 'manual' ? o.subgroupMode : 'fixed',
    sigmaMode: o.sigmaMode === 'S' ? 'S' : 'R',
    outlierMethod: o.outlierMethod === 'iqr' ? 'iqr' : 'grubbs',
    outlierConfirmedIds: asArray(o.outlierConfirmedIds).map((x) => String(x)),
    weRules,
    nelsonRules,
  };
}

function normalizeAiUsageLog(raw: unknown): Project['aiUsageLogs'][number] {
  const o = isObj(raw) ? raw : {};
  const features = ['chartExplain', 'capExplain', 'suggest', 'report', 'qa'] as const;
  const feature = features.find((f) => f === o.feature) ?? 'qa';
  return {
    id: typeof o.id === 'string' ? o.id : '',
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    feature,
    sentPayloadScope: o.sentPayloadScope === 'raw' ? 'raw' : 'summary',
    model: typeof o.model === 'string' ? o.model : '',
    requestedAt: typeof o.requestedAt === 'string' ? o.requestedAt : new Date().toISOString(),
    ok: o.ok === true,
  };
}
