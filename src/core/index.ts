/**
 * core 内核统一导出入口。
 *
 * 供 data / services / store / ui 层以 `@/core` 引入。
 * 使用显式命名导出，避免 `export *` 在同名符号上产生歧义
 * （如 chartFactory / controlChart 均导出 buildControlChart）。
 */

// types（类型专用）
export type {
  NumericArray,
  SpecLimits,
  MeasurementInput,
  SubgroupMode,
  SubgroupConfig,
  SubgroupStats,
  SigmaMode,
  SigmaEstimate,
  CapabilityResult,
  CapabilityWarning,
  ChartType,
  ChartPoint,
  ControlLine,
  ControlChartSeries,
  ControlChartConstants,
  AttributeInput,
  RuleGroup,
  NelsonRuleId,
  WesternRuleId,
  RuleId,
  RuleMeta,
  RuleContext,
  RuleViolation,
  RuleEvaluationResult,
  RuleToggleConfig,
  NormalityResult,
  HistogramResult,
  ParetoItem,
  ParetoResult,
  OutlierFlag,
} from './types';

// constants
export {
  getConstants,
  getD2,
  getC4,
  hasD3,
  hasB3,
  getAllConstantsRaw,
  MIN_SUBGROUP_N,
  MAX_SUBGROUP_N,
} from './constants/controlChartConstants';
export {
  RULE_META,
  ALL_RULE_IDS,
  EQUIVALENT_RULE,
  EQUAL_EPS,
  defaultToggleConfig,
} from './constants/ruleMeta';

// math
export {
  normalCdf,
  normalPdf,
  stdNormalCdf,
  stdNormalPdf,
  normalInvCdf,
  tQuantile,
  SQRT_2PI,
} from './math/normalCdf';
export {
  sortedAscending,
  sum,
  sumOfSquares,
  average,
  range,
  maxOf,
  minOf,
  allFinite,
} from './math/matrix';

// stats
export { mean, stdDev, median, rangeOf, skewness, kurtosis, sumOf } from './stats/descriptive';
export {
  isTwoSidedSpec,
  isOneSidedSpec,
  isMissingSpec,
  assertValidSpec,
  specCenter,
  specHalfWidth,
} from './stats/specLimits';
export { buildSubgroups, buildSubgroupsFromIds } from './stats/subgrouping';
export {
  computeCapability,
  estimateSigmaWithin,
  computePpm,
  movingRangeMean,
  type CapabilityOptions,
} from './stats/capability';
export { detectOutliers, grubbsTest, iqrTest } from './stats/outliers';
export {
  capabilityGrade,
  capabilityVerdictText,
  CPK_EXCELLENT,
  CPK_QUALIFIED,
  CPK_LOW,
  type CapabilityGrade,
} from './stats/capabilityVerdict';
export { buildHistogram, sturgesBinCount, STURGES } from './stats/histogram';

// charts
export { buildXbarR, xbarCenter, constLine } from './charts/xbarR';
export { buildXbarS } from './charts/xbarS';
export { buildImr, movingRanges } from './charts/imr';
export { buildP, buildNp, buildC, buildU } from './charts/attributes';
export {
  buildControlChart,
  sigmaByPointOf,
  type ControlChartInput,
  type VariablesChartInput,
  type ImrChartInput,
  type AttributesChartInput,
} from './charts/controlChart';

// rules
export {
  sideOf,
  zoneOf,
  isAllSameSide,
  isMonotonicIncreasing,
  isMonotonicDecreasing,
  isAlternating,
  countSameSideInZone,
  isAllInZoneC,
  isAllOutsideZoneC,
  hasTwoInZoneA,
  hasFourInZoneB,
  countSameSideAtPoint,
  isAllInZoneCAtPoint,
  isAllOutsideZoneCAtPoint,
  hasTwoInZoneAAtPoint,
  hasFourInZoneBAtPoint,
} from './rules/types';
export {
  evaluateW1,
  evaluateW2,
  evaluateW3,
  evaluateW4,
  evaluateWesternElectric,
} from './rules/westernElectric';
export {
  evaluateN1,
  evaluateN2,
  evaluateN3,
  evaluateN4,
  evaluateN5,
  evaluateN6,
  evaluateN7,
  evaluateN8,
  evaluateNelson,
} from './rules/nelson';
export {
  evaluateRules,
  evaluateRulesDefault,
  resolveEnabledRules,
  buildPointRuleMap,
  dedupeViolations,
} from './rules/index';

// normality
export {
  testNormality,
  normalityConclusion,
  andersonDarling,
  adPValue,
  shapiroWilk,
  swPValue,
  shapiroWilkCoefficients,
  SW_MAX_N,
  type NormalityTestBundle,
} from './normality/index';

// pareto
export { buildPareto, DEFAULT_OTHER_THRESHOLD, DEFAULT_CROSSING_THRESHOLD } from './pareto/pareto';

// ai
export {
  buildChartSummary,
  buildCapabilitySummary,
  type ChartSummaryInput,
  type CapabilitySummaryInput,
} from './ai/summary';
