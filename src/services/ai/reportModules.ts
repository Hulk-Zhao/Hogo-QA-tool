/**
 * reportModules —— 把报表中间模型拆成「每个模块一份可发送的统计摘要」。
 *
 * 用户需求：「导出的报表每个模块都有 AI 分析」。因此这里定义**报表模块清单**
 * 与每个模块的摘要内容，供 AI 导出逐模块出分析。
 *
 * 数据主权硬约束（架构 §7.3）：
 *  - 本模块产出的摘要**只含统计量**（n / 均值 / σ / 指数 / 控制限 / 占比…），
 *    绝不包含逐条原始测量值数组；
 *  - 每个数字都能在 `ReportModel` 或 `ReportModuleExtras` 里找到来源，
 *    用例逐条比对（禁止「模型自己编数字」的土壤）。
 */

import type { AnalysisFocusId } from './analysisFocus';
import type { ReportModel } from '@/data/exporter/reportModel';

/** 报表模块标识。 */
export type ReportModuleId =
  | 'cpk'
  | 'defect'
  | 'controlChart'
  | 'pareto'
  | 'capabilityChart'
  | 'rawDimensions';

/** 一个模块的 AI 分析输入。 */
export interface ReportModule {
  id: ReportModuleId;
  /** 模块标题（界面与导出文档共用）。 */
  title: string;
  /** 送给模型的统计摘要（只含统计量）。 */
  summary: Record<string, unknown>;
  /** 数据不足以分析时的说明；为空表示该模块有可分析内容。 */
  unavailable: string | null;
  /**
   * 本模块**适用**的分析方向。
   *
   * 为什么必须有这个字段：用户实测（本轮反馈的截图）里，模型在「不良统计」这类
   * 纯计数模块上反复写「摘要未提供均值、组内 σ、控制限与子组编号，无法判断是否
   * 统计受控」—— 根因是上一轮把用户勾选的**全部**方向塞给了每一个模块。
   * 只发适用的方向，模型才不会用「摘要未提供…」占满版面。
   */
  applicableFocus: AnalysisFocusId[];
  /**
   * 本模块的数据口径（一句话）。写进 prompt 告诉模型哪些字段**本来就没有**，
   * 免得它把「计数数据没有 σ」写成数据缺失。
   */
  dataScope: string;
}

/**
 * 控制图模块的补充信息（来自报表页已经算好的控制图状态）。
 *
 * 控制限本来可以只由均值 ± 3σ_within 推导，但**判异结论**必须用页面真实算出来的
 * 那份结果，否则会出现「报表上标了 3 个红点、AI 却说没有异常」。因此允许注入。
 */
export interface ReportModuleExtras {
  controlChart?: {
    characteristicName: string;
    centerLine: number;
    ucl: number;
    lcl: number;
    violations: { rule: string; pointIndex: number }[];
  } | null;
}

/** 指数取 4 位小数（与报表口径一致），非有限值给 null。 */
function num(value: number | null | undefined, decimals = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 能力指数判定门槛（与报表页 / README / 架构口径一致）。
 *
 * 上一轮的摘要里没有这两个数，模型只能写「无法与 1.33、1.67 对照」；
 * 把门槛随摘要一起发过去，这段废话就没了。
 */
export const CAPABILITY_BENCHMARK = {
  acceptable: 1.33,
  excellent: 1.67,
  note: 'Cpk / Ppk：≥ 1.33 为合格，≥ 1.67 为优秀（本工具口径）',
} as const;

/**
 * 样本标准差（整体口径，除以 n-1）。
 *
 * @param values 数值序列
 * @returns σ；有效样本 < 2 时返回 null
 */
export function sampleSigma(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return null;
  }
  const mean = clean.reduce((sum, v) => sum + v, 0) / clean.length;
  const variance = clean.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (clean.length - 1);
  const sigma = Math.sqrt(variance);
  return Number.isFinite(sigma) ? sigma : null;
}

/** 规格中心（上下限都在时才有意义）。 */
function specCenter(usl: number | null, lsl: number | null): number | null {
  if (usl === null || lsl === null || !Number.isFinite(usl) || !Number.isFinite(lsl)) {
    return null;
  }
  return num((usl + lsl) / 2);
}

/**
 * 由均值与组内 σ 推导控制限（3σ 口径），用于控制图模块。
 *
 * @param mean 均值
 * @param sigmaWithin 组内 σ
 * @returns { centerLine, ucl, lcl }
 */
export function controlLimits(mean: number, sigmaWithin: number): {
  centerLine: number;
  ucl: number;
  lcl: number;
} | null {
  if (!Number.isFinite(mean) || !Number.isFinite(sigmaWithin) || sigmaWithin <= 0) {
    return null;
  }
  return {
    centerLine: num(mean)!,
    ucl: num(mean + 3 * sigmaWithin)!,
    lcl: num(mean - 3 * sigmaWithin)!,
  };
}

/** CPK 汇总模块。 */
function cpkModule(model: ReportModel): ReportModule {
  const rows = model.cpkSummary;
  return {
    id: 'cpk',
    title: 'CPK 汇总',
    unavailable: rows.length === 0 ? '本次没有可用的过程能力结果（缺少测量值或规格限）。' : null,
    dataScope:
      '本模块含每个特性的 n / 均值 / 组内 σ / 整体 σ / 规格上下限 / 规格中心 / 均值偏离规格中心'
      + ' / Ca / Cp / Cpk / Pp / Ppk / 双西格玛水平 / PPM；不含逐条测量值，也不含逐点判异结果。',
    applicableFocus: ['capability', 'delivery', 'riskWarning', 'improvement'],
    summary: {
      module: 'CPK汇总',
      capabilityBenchmark: CAPABILITY_BENCHMARK,
      characteristicCount: rows.length,
      characteristics: rows.map((r) => {
        const center = specCenter(r.usl, r.lsl);
        return {
          characteristicName: r.characteristic,
          n: r.n,
          mean: num(r.mean),
          sigmaWithin: num(r.sigmaWithin),
          sigmaOverall: num(r.sigmaOverall),
          usl: num(r.usl),
          lsl: num(r.lsl),
          specCenter: center,
          meanShiftFromSpecCenter:
            center === null || !Number.isFinite(r.mean) ? null : num(r.mean - center),
          ca: num(r.ca, 3),
          cp: num(r.cp, 3),
          cpk: num(r.cpk, 3),
          pp: num(r.pp, 3),
          ppk: num(r.ppk, 3),
          sigmaLevelShort: num(r.sigmaLevelShort, 2),
          ppmOverall: r.ppmOverall === null ? null : Math.round(r.ppmOverall),
        };
      }),
    },
  };
}

/** 不良统计模块。 */
function defectModule(model: ReportModel): ReportModule {
  const rows = model.defectStats;
  return {
    id: 'defect',
    title: '不良统计',
    unavailable: rows.length === 0 ? '本次未导入不良记录，无法进行不良统计。' : null,
    dataScope:
      '本模块是**计数（不良）**数据：只有不良类型、数量、占比、累计占比与总不良数；'
      + '计数数据本身**没有**均值、σ、控制限与子组编号，也不需要逐点原始数据。',
    applicableFocus: ['defectPareto', 'riskWarning', 'improvement'],
    summary: {
      module: '不良统计',
      defectTypeCount: rows.length,
      totalDefectCount: rows.reduce((sum, r) => sum + r.count, 0),
      cumulativeRatioNote: 'cumRatioPercent 为按数量降序的累计占比（柏拉图口径）。',
      rows: rows.map((r) => ({
        defectType: r.defectType,
        count: r.count,
        ratioPercent: num(r.ratio, 2),
        cumRatioPercent: num(r.cumRatio, 2),
      })),
    },
  };
}

/**
 * 控制图模块。
 *
 * @param model 报表模型
 * @param extras 控制图补充信息（可为空 → 只给推导出来的控制限）
 */
function controlModule(model: ReportModel, extras?: ReportModuleExtras): ReportModule {
  const usable = model.cpkSummary.filter((r) => controlLimits(r.mean, r.sigmaWithin) !== null);
  const injected = extras?.controlChart ?? null;
  const violations = injected?.violations ?? [];
  return {
    id: 'controlChart',
    title: '控制图',
    unavailable:
      usable.length === 0 && !injected
        ? '本次无法构造控制图（子组容量或测量值数量不足）。'
        : null,
    dataScope:
      '本模块含各特性的中心线 / UCL / LCL（中心线 = 均值，UCL/LCL = 均值 ± 3 × 组内 σ）与 n；'
      + '被聚焦的特性还含**页面上已算出的真实判异结果**（规则名 + 子组编号）。'
      + '不含逐点原始测量值。',
    applicableFocus: ['stability', 'riskWarning', 'improvement'],
    summary: {
      module: '控制图',
      controlLimitBasis: '中心线 = 均值；UCL/LCL = 均值 ± 3 × 组内 σ',
      // 注意：这里只说「可构造控制图的特性」有多少个，不谎称是逐点判异结果。
      characteristics: model.cpkSummary.map((r) => {
        const limits = controlLimits(r.mean, r.sigmaWithin);
        return {
          characteristicName: r.characteristic,
          n: r.n,
          centerLine: limits?.centerLine ?? null,
          ucl: limits?.ucl ?? null,
          lcl: limits?.lcl ?? null,
          controlChartAvailable: limits !== null,
        };
      }),
      focusedCharacteristic: injected
        ? {
            characteristicName: injected.characteristicName,
            centerLine: num(injected.centerLine),
            ucl: num(injected.ucl),
            lcl: num(injected.lcl),
            violationCount: violations.length,
            // 判异点必须**挂到特性名下**：上一轮的截图里模型写「第 22 点落 A 区…
            // 摘要未指明归属特性」，就是因为 violations 与特性是两条并列字段。
            violations: violations.map((v) => ({
              rule: v.rule,
              subgroupIndex: v.pointIndex + 1,
              characteristicName: injected.characteristicName,
            })),
          }
        : null,
      violationCount: injected ? violations.length : null,
      violationsNote: injected
        ? '判异结果来自页面真实计算（subgroupIndex 为子组编号，从 1 起），已归入 focusedCharacteristic。'
        : '本次未提供逐点判异结果，禁止声称某个子组超出控制限。',
    },
  };
}

/** 柏拉图模块。 */
function paretoModule(model: ReportModel): ReportModule {
  const rows = model.defectStats;
  const inside = rows.filter((r) => r.cumRatio <= 80 + 1e-9);
  return {
    id: 'pareto',
    title: '柏拉图（80% 分界线）',
    unavailable: rows.length === 0 ? '本次未导入不良记录，无法生成柏拉图。' : null,
    dataScope:
      '本模块是**不良计数**的柏拉图口径：不良类型、数量、占比、累计占比，以及落在 80% 分界线内的类型；'
      + '计数数据本身**没有**均值、σ、控制限与子组编号。',
    applicableFocus: ['defectPareto', 'riskWarning', 'improvement'],
    summary: {
      module: '柏拉图',
      cutLinePercent: 80,
      withinCutLine: inside.map((r) => ({
        defectType: r.defectType,
        count: r.count,
        cumRatioPercent: num(r.cumRatio, 2),
      })),
      allRows: rows.map((r) => ({
        defectType: r.defectType,
        count: r.count,
        ratioPercent: num(r.ratio, 2),
        cumRatioPercent: num(r.cumRatio, 2),
      })),
    },
  };
}

/** 能力图（直方图 + 规格限）模块。 */
function capabilityModule(model: ReportModel): ReportModule {
  const rows = model.cpkSummary;
  const withSpec = rows.filter((r) => r.usl !== null || r.lsl !== null);
  return {
    id: 'capabilityChart',
    title: '能力图（直方图 + USL/LSL）',
    unavailable:
      withSpec.length === 0
        ? '本次没有同时具备测量值与规格限的特性，无法生成能力图。'
        : null,
    dataScope:
      '本模块含具备规格限的各特性 n / 均值 / 组内 σ / 整体 σ / 规格限 / 规格中心 / Cp / Cpk / Ppk / PPM，'
      + '以及由「均值 ± 3 × 组内 σ」推导的中心线与控制限；不含逐点原始测量值与逐点判异结果。',
    applicableFocus: ['capability', 'stability', 'riskWarning', 'improvement'],
    summary: {
      module: '能力图',
      capabilityBenchmark: CAPABILITY_BENCHMARK,
      controlLimitBasis: '中心线 = 均值；UCL/LCL = 均值 ± 3 × 组内 σ（由摘要推导）',
      characteristics: withSpec.map((r) => {
        const limits = controlLimits(r.mean, r.sigmaWithin);
        const center = specCenter(r.usl, r.lsl);
        return {
          characteristicName: r.characteristic,
          n: r.n,
          mean: num(r.mean),
          sigmaWithin: num(r.sigmaWithin),
          sigmaOverall: num(r.sigmaOverall),
          usl: num(r.usl),
          lsl: num(r.lsl),
          specCenter: center,
          centerLine: limits?.centerLine ?? null,
          ucl: limits?.ucl ?? null,
          lcl: limits?.lcl ?? null,
          cp: num(r.cp, 3),
          cpk: num(r.cpk, 3),
          ppk: num(r.ppk, 3),
          ppmOverall: r.ppmOverall === null ? null : Math.round(r.ppmOverall),
        };
      }),
    },
  };
}

/** 原始尺寸模块（只给分布形态统计，不给逐条明细）。 */
function rawDimensionModule(model: ReportModel): ReportModule {
  const byCharacteristic = new Map<string, { values: number[]; usl: number | null; lsl: number | null }>();
  for (const row of model.rawDimensions) {
    const entry = byCharacteristic.get(row.characteristic);
    if (entry) {
      entry.values.push(row.value);
      entry.usl = entry.usl ?? (Number.isFinite(row.usl) ? row.usl : null);
      entry.lsl = entry.lsl ?? (Number.isFinite(row.lsl) ? row.lsl : null);
    } else {
      byCharacteristic.set(row.characteristic, {
        values: [row.value],
        usl: Number.isFinite(row.usl) ? row.usl : null,
        lsl: Number.isFinite(row.lsl) ? row.lsl : null,
      });
    }
  }
  let totalCount = 0;
  const stats = [...byCharacteristic.entries()].map(([name, entry]) => {
    const { values } = entry;
    totalCount += values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    return {
      characteristicName: name,
      count: values.length,
      // 用户原话「对摘要未提供均值进行优化」：均值与整体 σ 都补上，
      // 仍然只是统计量，不发送逐条测量值。
      mean: num(mean),
      sigmaOverall: num(sampleSigma(values)),
      min: num(sorted[0]),
      max: num(sorted[sorted.length - 1]),
      span: num(sorted[sorted.length - 1] - sorted[0]),
      usl: num(entry.usl),
      lsl: num(entry.lsl),
    };
  });
  return {
    id: 'rawDimensions',
    title: '原始尺寸',
    unavailable: stats.length === 0 ? '本次没有原始尺寸明细可导出。' : null,
    dataScope:
      '本模块只提供每个特性的条数 / 均值 / 整体 σ / 极值 / 极差（**不发送逐条测量值**）；'
      + '没有组内 σ、控制限与子组编号，规格限仅在原表填了 USL/LSL 时才有。',
    // 刻意**不含 stability**：本模块没有控制限与子组编号（见 dataScope），
    // 真要它判稳定性，模型只能回一句「无法判断是否受控」——即用户看到的噪音。
    applicableFocus: ['capability', 'improvement'],
    summary: {
      module: '原始尺寸',
      note: '仅提供每个特性的条数、均值、整体 σ 与极值统计，未发送逐条测量值。',
      totalCount,
      characteristics: stats,
    },
  };
}

/**
 * 由报表模型构造模块清单（固定 6 个模块，顺序固定）。
 *
 * @param model 报表中间模型
 * @param extras 控制图补充信息
 * @returns 模块清单
 */
export function buildReportModules(
  model: ReportModel,
  extras?: ReportModuleExtras,
): ReportModule[] {
  return [
    cpkModule(model),
    defectModule(model),
    controlModule(model, extras),
    paretoModule(model),
    capabilityModule(model),
    rawDimensionModule(model),
  ];
}

/** 需要 AI 分析的模块（有内容才调用，避免为「无数据」白烧一次请求）。 */
export function analyzableModules(modules: ReportModule[]): ReportModule[] {
  return modules.filter((m) => m.unavailable === null);
}
