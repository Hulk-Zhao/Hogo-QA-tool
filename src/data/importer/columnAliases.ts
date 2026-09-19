/**
 * columnAliases：旧工具/现场常见列名别名表（PRD §10 待议项 7）。
 *
 * 匹配策略：规范化（去空白、全角转半角、转小写）后与别名集合比较。
 * 允许 `USL`/`usl`/`规格上限` 等变体，避免要求用户改列名（P0-15）。
 */

import type { FieldRole } from './types';

/** 规范化列名：去首尾空白、全角空格→半角、压缩内部空白、转小写。 */
export function normalizeColumnName(raw: string): string {
  return raw
    .replace(/\u3000/g, ' ') // 全角空格
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 角色别名表：role → 别名集合（均须为规范化后的小写形式）。
 * 数值/规格限类别名额外覆盖英文与常见中文变体。
 */
export const COLUMN_ALIASES: Record<FieldRole, string[]> = {
  material: [
    '物料名称',
    '物料',
    '物料名',
    '零件名称',
    '产品名称',
    '特性名称',
    '特性',
    '项目',
    'item',
    'name',
    'material',
    'partname',
    'characteristic',
  ],
  value: [
    '测量值',
    '测量数据',
    '测量',
    '数值',
    '实测值',
    '实测',
    '尺寸',
    '数据',
    'value',
    'measurement',
    'measured',
    'reading',
    'x',
  ],
  usl: ['usl', '规格上限', '上限', '上规格限', '上公差', '上偏差', '规格上限值', 'uplimit', 'upperlimit', 'usl值'],
  lsl: ['lsl', '规格下限', '下限', '下规格限', '下公差', '下偏差', '规格下限值', 'lowlimit', 'lowerlimit', 'lsl值'],
  target: ['target', '目标值', '名义值', '中心值', '标准值', 'nominal', '标称值'],
  subgroup: [
    '子组',
    '子组号',
    '分组',
    '组号',
    '批次',
    '样本组',
    'subgroup',
    'group',
    'sample',
    'batchno',
  ],
  defectType: [
    '不良类型',
    '不良项目',
    '缺陷类型',
    '缺陷项目',
    '不良现象',
    '不良名称',
    '缺陷',
    '不良',
    'defecttype',
    'defect',
    'type',
    'category',
    '问题类型',
  ],
  defectCount: [
    '不良数量',
    '不良数',
    '缺陷数量',
    '缺陷数',
    '数量',
    '件数',
    '频数',
    '次数',
    'defectcount',
    'count',
    'qty',
    'quantity',
    'frequency',
  ],
  date: ['日期', '时间', 'datetime', 'date', 'time', '测量时间', '检验日期'],
  batch: ['批次号', '批号', 'lotno', 'lot', 'batchno', 'batch'],
  ignore: [],
};

/** 反向索引：规范化别名 → 角色（同一别名归属多个 role 时，先注册者优先）。 */
const ALIAS_TO_ROLE: Map<string, FieldRole> = (() => {
  const m = new Map<string, FieldRole>();
  const roles: FieldRole[] = [
    'material',
    'value',
    'usl',
    'lsl',
    'target',
    'subgroup',
    'defectType',
    'defectCount',
    'date',
    'batch',
  ];
  for (const role of roles) {
    for (const alias of COLUMN_ALIASES[role]) {
      const key = normalizeColumnName(alias);
      if (!m.has(key)) {
        m.set(key, role);
      }
    }
  }
  return m;
})();

/**
 * 将单个列名解析为角色；无法识别返回 null。
 */
export function resolveRole(columnName: string): FieldRole | null {
  return ALIAS_TO_ROLE.get(normalizeColumnName(columnName)) ?? null;
}

/** 判断某角色是否为必需（缺失将导致导入失败）。 */
export function requiredRoles(sourceType: 'dimension' | 'defect'): FieldRole[] {
  if (sourceType === 'dimension') {
    return ['material', 'value'];
  }
  return ['defectType', 'defectCount'];
}
