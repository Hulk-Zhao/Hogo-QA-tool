/**
 * 12 条判异准则的元数据（编号 / 名称 / 来源 / 分组 / 默认开关）。
 *
 * 出处：Western Electric (1956) 与 Nelson (1984), Journal of Quality Technology 16(4)。
 */

import type { NelsonRuleId, RuleId, RuleMeta, RuleToggleConfig, WesternRuleId } from '../types';

/** 西方电气 4 条规则元数据。 */
const WESTERN_META: Record<WesternRuleId, RuleMeta> = {
  W1: {
    id: 'W1',
    group: 'westernElectric',
    shortName: '1点超3σ',
    description: '任意 1 点落在 ±3σ 之外（严格大于 3σ）。',
    source: 'Western Electric 1956',
  },
  W2: {
    id: 'W2',
    group: 'westernElectric',
    shortName: '9点同侧',
    description: '连续 9 点落在中心线同一侧。',
    source: 'Western Electric 1956',
  },
  W3: {
    id: 'W3',
    group: 'westernElectric',
    shortName: '6点递增/递减',
    description: '连续 6 点严格递增或严格递减（相等即打断）。',
    source: 'Western Electric 1956',
  },
  W4: {
    id: 'W4',
    group: 'westernElectric',
    shortName: '14点交替',
    description: '连续 14 点上下交替（相邻差符号交替，不允许相等）。',
    source: 'Western Electric 1956',
  },
};

/** 尼尔森 8 条规则元数据。 */
const NELSON_META: Record<NelsonRuleId, RuleMeta> = {
  N1: {
    id: 'N1',
    group: 'nelson',
    shortName: '1点超3σ',
    description: '任意 1 点落在 ±3σ 之外（同 W1）。',
    source: 'Nelson 1984 JQT',
  },
  N2: {
    id: 'N2',
    group: 'nelson',
    shortName: '9点同侧',
    description: '连续 9 点落在中心线同一侧（同 W2）。',
    source: 'Nelson 1984 JQT',
  },
  N3: {
    id: 'N3',
    group: 'nelson',
    shortName: '6点递增/递减',
    description: '连续 6 点持续上升或下降（同 W3）。',
    source: 'Nelson 1984 JQT',
  },
  N4: {
    id: 'N4',
    group: 'nelson',
    shortName: '14点交替',
    description: '连续 14 点上下交替（同 W4）。',
    source: 'Nelson 1984 JQT',
  },
  N5: {
    id: 'N5',
    group: 'nelson',
    shortName: '3点中2点在A区',
    description: '连续 3 点中有 2 点落在中心线同一侧的 A 区或以外（≥2σ）。',
    source: 'Nelson 1984 JQT',
  },
  N6: {
    id: 'N6',
    group: 'nelson',
    shortName: '5点中4点在B区外',
    description: '连续 5 点中有 4 点落在中心线同一侧的 B 区或以外（≥1σ）。',
    source: 'Nelson 1984 JQT',
  },
  N7: {
    id: 'N7',
    group: 'nelson',
    shortName: '15点在C区',
    description: '连续 15 点全部落在中心线两侧的 C 区（严格 <1σ）。',
    source: 'Nelson 1984 JQT',
  },
  N8: {
    id: 'N8',
    group: 'nelson',
    shortName: '8点在C区外',
    description: '连续 8 点全部落在 C 区以外（≥1σ，不限同侧）。',
    source: 'Nelson 1984 JQT',
  },
};

/** 全部 12 条规则的元数据表（按 RuleId 索引）。 */
export const RULE_META: Record<RuleId, RuleMeta> = {
  ...WESTERN_META,
  ...NELSON_META,
};

/** 全部规则 id 列表（顺序：W1..W4、N1..N8）。 */
export const ALL_RULE_IDS: RuleId[] = ['W1', 'W2', 'W3', 'W4', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'];

/** 西格玛水平 / 规则判定所用的浮点相等容差。 */
export const EQUAL_EPS = 1e-9;

/** Wk <-> Nk 的等价映射（k=1..4）。 */
export const EQUIVALENT_RULE: Partial<Record<RuleId, RuleId>> = {
  W1: 'N1',
  N1: 'W1',
  W2: 'N2',
  N2: 'W2',
  W3: 'N3',
  N3: 'W3',
  W4: 'N4',
  N4: 'W4',
};

/**
 * 默认规则开关：西方电气 4 条默认全开；尼尔森默认开启 N5/N7/N8
 * （与 W1..W4 不重复的部分），N1..N4 因与 W 系列等价默认关闭，避免重复告警。
 */
export function defaultToggleConfig(): RuleToggleConfig {
  return {
    westernElectric: { W1: true, W2: true, W3: true, W4: true },
    nelson: { N1: false, N2: false, N3: false, N4: false, N5: true, N6: true, N7: true, N8: true },
  };
}
