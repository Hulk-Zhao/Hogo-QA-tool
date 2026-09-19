/**
 * Hogo-QA-tool 统计内核类型定义（唯一权威）。
 *
 * 出处：架构文档 §3。所有 core 模块的类型必须引用本文件，
 * 禁止在别处重复定义等价类型。
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export type NumericArray = number[];

/** 规格限；null 表示未提供（单侧规格场景） */
export interface SpecLimits {
  usl: number | null;
  lsl: number | null;
  target: number | null;
  unit: string;
}

/** 单条测量记录（内核视角，非持久化实体） */
export interface MeasurementInput {
  id: string;
  value: number;
  /** 预分组时提供 */
  subgroupId?: string;
  /** 已确认排除 */
  excluded?: boolean;
}

/** 子组划分模式 */
export type SubgroupMode = 'fixed' | 'byColumn' | 'manual';

export interface SubgroupConfig {
  mode: SubgroupMode;
  /** fixed 模式必填，n>=2 整数 */
  capacity?: number;
  /** byColumn：与测量值一一对应的分组键 */
  columnValues?: string[];
  /** manual：子组起始索引（升序） */
  manualBoundaries?: number[];
}

/** 计算得到的子组统计（内核输出） */
export interface SubgroupStats {
  id: string;
  /** 从 0 开始 */
  index: number;
  /** n */
  size: number;
  /** 参与计算的（未排除）值 */
  values: number[];
  /** X̄_i */
  mean: number;
  /** R_i = max - min */
  range: number;
  /** s_i (ddof=1, n>=2) */
  std: number;
}

/** 标准差双口径 */
export type SigmaMode = 'R' | 'S';

export interface SigmaEstimate {
  mode: SigmaMode | 'IMR' | 'OVERALL';
  /** σ_within */
  within: number;
  /** σ_overall (ddof=1) */
  overall: number;
  /** R̄（R 法） */
  rBar?: number;
  /** S̄（S 法） */
  sBar?: number;
  /** MR̄（I-MR） */
  mrBar?: number;
  /** 实际采用哪种估计组内 σ */
  basis: 'R' | 'S' | 'IMR';
}

/** 能力指数结果 */
export interface CapabilityResult {
  /** 有效测量数 */
  n: number;
  mean: number;
  sigma: SigmaEstimate;
  spec: SpecLimits;

  /** 准确度 */
  ca: number | null;
  /** 单侧规格时 null */
  cp: number | null;
  cpk: number | null;
  cpu: number | null;
  cpl: number | null;
  pp: number | null;
  ppk: number | null;
  ppu: number | null;
  ppl: number | null;

  /** 3 * Cpk */
  sigmaLevelShort: number | null;
  /** 3 * Cpk + 1.5 */
  sigmaLevelBench: number | null;

  /** 基于 σ_overall 的双侧期望 PPM */
  ppmOverall: number | null;
  /** 基于 σ_within 的潜在 PPM */
  ppmWithin: number | null;

  warnings: CapabilityWarning[];
}

export type CapabilityWarning =
  | 'NO_SUBGROUP_STRUCTURE'
  | 'ONLY_ONE_SIDED_SPEC'
  | 'SIGMA_WITHIN_ZERO'
  | 'NON_NORMAL_DATA'
  | 'INSUFFICIENT_SAMPLE';

// ---------------------------------------------------------------------------
// 控制图类型
// ---------------------------------------------------------------------------

export type ChartType = 'Xbar-R' | 'Xbar-S' | 'I-MR' | 'P' | 'NP' | 'C' | 'U';

/** 单个数据点的图坐标（含变限） */
export interface ChartPoint {
  /** 0-based */
  index: number;
  /** 子组号 / 样本号 / 批次 */
  xLabel: string;
  /** 主图绘制值（X̄ / I / p̂ / ...） */
  value: number;
  subgroupId?: string;
  /** 用于变限 */
  subgroupSize: number;
}

/** 一条控制限序列（变限时为逐点不同） */
export interface ControlLine {
  /** 'CL' | 'UCL' | 'LCL' */
  label: string;
  /** 与 points 等长 */
  values: number[];
  /** 恒定限为 true（图示可简化） */
  isConstant: boolean;
}

export interface ControlChartSeries {
  /** 主图（Xbar / I / P / NP / C / U） */
  primary: {
    /** 'X̄' | 'I' | 'p' | ... */
    name: string;
    points: ChartPoint[];
  };
  /** 副图（R / S / MR），I-MR 与计量型有，计数型无 */
  secondary?: {
    /** 'R' | 'S' | 'MR' */
    name: string;
    points: ChartPoint[];
  };
  limits: {
    primary: ControlLine[];
    secondary?: ControlLine[];
  };
  /** 计量型主图才有（相对 CL 的 ±1σ/±2σ） */
  sigmaZones?: {
    centerLine: number;
    /** σ̂（用于画分区带） */
    oneSigma: number;
  };
  constantsUsed: Partial<ControlChartConstants> & { n: number };
  selectedType: ChartType;
}

export interface ControlChartConstants {
  n: number;
  A2: number;
  A3: number;
  /** 无定义时为 null（n <= 6） */
  D3: number | null;
  D4: number;
  /** 无定义时为 null（n <= 5） */
  B3: number | null;
  B4: number;
  d2: number;
  E2: number;
  c4: number;
}

/** 计数型输入 */
export interface AttributeInput {
  /** 每个样本：不良数（P/NP 用）或缺陷数（C/U 用） */
  defectivesOrDefects: number[];
  /** 每个样本的样本量；NP/C 需恒定 */
  sampleSizes: number[];
}

// ---------------------------------------------------------------------------
// 判异规则类型
// ---------------------------------------------------------------------------

export type RuleGroup = 'westernElectric' | 'nelson';

export type NelsonRuleId = 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7' | 'N8';

export type WesternRuleId = 'W1' | 'W2' | 'W3' | 'W4';

export type RuleId = WesternRuleId | NelsonRuleId;

/** 单条规则的元数据 */
export interface RuleMeta {
  id: RuleId;
  group: RuleGroup;
  /** '1点超3σ' */
  shortName: string;
  /** 完整中文说明 */
  description: string;
  source: 'Western Electric 1956' | 'Nelson 1984 JQT';
}

/** 规则判定的通用上下文 */
export interface RuleContext {
  /** 主图数值序列（X̄ / I / p̂ / c / u / np），已按原始顺序 */
  values: number[];
  /** 中心线 CL（计量型为 X̄，计数型为 p̄/c̄/ū/np̄） */
  centerLine: number;
  /** 常量 σ 情况下的标准差（计量型：σ_within 估计值；I-MR：MR̄/d2(n=2)） */
  sigma: number;
  /** 每条点对应的 σ（变限 P/U 用；常量时全部相同） */
  sigmaByPoint: number[];
  /** 每条点对应的子组容量（变限 P/U 用） */
  subgroupSizes: number[];
}

/** 一次判异命中 */
export interface RuleViolation {
  ruleId: RuleId;
  ruleGroup: RuleGroup;
  /** 违规涉及的点索引（升序，长度 >=1；区间型规则给全部涉及点） */
  pointIndices: number[];
  /** 触发该违规的「窗口起点」——列表展示与图上定位用 */
  windowStart: number;
  /** 人类可读描述，如「第 12–20 点连续 9 点在中心线上方」 */
  message: string;
  severity: 'high' | 'medium' | 'low';
}

export interface RuleEvaluationResult {
  violations: RuleViolation[];
  /** 每个点被命中的规则集合，供图上高亮 */
  pointRuleMap: Record<number, RuleId[]>;
  /** 实际启用的规则 id */
  enabledRules: RuleId[];
}

export interface RuleToggleConfig {
  westernElectric: Record<WesternRuleId, boolean>;
  nelson: Record<NelsonRuleId, boolean>;
}

// ---------------------------------------------------------------------------
// 正态性检验类型
// ---------------------------------------------------------------------------

export interface NormalityResult {
  method: 'AD' | 'SW';
  statistic: number;
  /** 近似 p 值；无法给精确 p 时给等价判定 */
  pValue: number;
  /** pValue >= 0.05 */
  isNormal: boolean;
  /** 当 n 或条件超出方法适用范围时给出 */
  note?: string;
  /** 两种方法都给，UI 优先展示 S-W（n<=50） */
  companion?: {
    method: 'AD' | 'SW';
    statistic: number;
    pValue: number;
  };
}

// ---------------------------------------------------------------------------
// 直方图与柏拉图
// ---------------------------------------------------------------------------

export interface HistogramResult {
  bins: { x0: number; x1: number; count: number; label: string }[];
  binWidth: number;
  binCount: number;
  rule: 'sturges' | number;
}

export interface ParetoItem {
  defectType: string;
  count: number;
  /** 占比 % */
  ratio: number;
  /** 累计占比 % */
  cumRatio: number;
  isOther: boolean;
}

export interface ParetoResult {
  /** 降序 */
  items: ParetoItem[];
  total: number;
  /** 累计首次 >= 阈值（默认 80）的项索引 */
  crossingIndex: number | null;
  /** 默认 80 */
  threshold: number;
}

// ---------------------------------------------------------------------------
// 异常值识别
// ---------------------------------------------------------------------------

export interface OutlierFlag {
  /** 对应输入数组的下标 */
  index: number;
  method: 'grubbs' | 'iqr';
  statistic: number;
  threshold: number;
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// 不良记录（core 视角）
// ---------------------------------------------------------------------------

/** 不良记录（内核视角；持久化实体见 data/schema.ts 的 DefectRecord） */
export interface DefectRecordInput {
  defectType: string;
  count: number;
  category?: string | null;
}
