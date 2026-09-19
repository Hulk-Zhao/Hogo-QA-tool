/**
 * columnAliases：旧工具/现场常见列名别名表（PRD §10 待议项 7）。
 *
 * 匹配策略：规范化（去空白、全角转半角、转小写）后与别名集合比较。
 * 允许 `USL`/`usl`/`规格上限` 等变体，避免要求用户改列名（P0-15）。
 */

import type { FieldRole } from './types';

/**
 * 全角 → 半角（全角可见区 U+FF01–U+FF5E 与全角空格 U+3000）。
 *
 * 为什么需要：现场 Excel/CSV 常残留中文输入法打出的全角字符，`ＵＳＬ` 与半角
 * `USL` 属于**同一列语义**。若不做归一化，导入向导会整列判为「未识别列」，
 * 用户被迫改列名——与 PRD P0-15「避免要求用户改列名」的初衷相悖。
 *
 * 仅做字符宽度归一，不做大小写折叠（由 {@link normalizeColumnName} 负责）。
 *
 * @param s 原始字符串（可能含全角字符）
 * @returns 全角可见字符与全角空格已转半角的字符串
 */
export function toHalfWidthAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

/** 规范化列名：全角转半角、去首尾空白、压缩内部空白、转小写。 */
export function normalizeColumnName(raw: string): string {
  return toHalfWidthAscii(raw)
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
