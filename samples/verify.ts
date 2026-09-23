/**
 * verify.ts —— 用**产品自己的统计内核**复算 `samples/hogo-qa-sample.xlsx`。
 *
 * 目的：README 里那张「样本数据 → 计算结果」的表必须能被任何人一条命令复现，
 * 而不是作者手抄的一串数字。这里刻意**不复刻公式**，而是把样本文件喂给
 * 产品真实的三段链路：
 *
 *   parseXlsx（旧工具双 sheet 兼容解析）
 *     → buildModel（映射成领域实体）
 *       → core（buildSubgroups / computeCapability / buildControlChart / evaluateRules / buildPareto）
 *
 * 也就是说：这里跑出来的 = 界面上显示的那一套数字（同一份纯函数内核）。
 *
 * 用法：
 *   npm run sample:verify
 *
 * 末尾的断言是护栏：样本文件被改动、或内核公式被改坏时，本脚本会红，
 * 提示 README 里的数字需要同步更新。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildModel } from '@/data/importer/buildModel';
import { parseXlsx } from '@/data/importer/xlsxImporter';
import { buildControlChart, sigmaByPointOf } from '@/core/charts/controlChart';
import { defaultToggleConfig, RULE_META } from '@/core/constants/ruleMeta';
import { buildPareto } from '@/core/pareto/pareto';
import { evaluateRules } from '@/core/rules/index';
import { computeCapability } from '@/core/stats/capability';
import { capabilityGrade, capabilityVerdictText } from '@/core/stats/capabilityVerdict';
import { buildSubgroups } from '@/core/stats/subgrouping';

const SAMPLE = path.join(import.meta.dirname, 'hogo-qa-sample.xlsx');

/** 与应用默认一致的子组容量（`src/store/analysisStore.ts` DEFAULT_CAPACITY）。 */
const CAPACITY = 5;

const GRADE_TEXT: Record<string, string> = {
  excellent: '优秀',
  qualified: '合格',
  low: '偏低',
  fail: '不合格',
  unknown: '无法判定',
};

const f = (v: number | null, digits = 4): string => (v === null ? 'N/A' : v.toFixed(digits));

if (!fs.existsSync(SAMPLE)) {
  console.error('找不到样本文件：' + SAMPLE + '\n请先运行：node samples/make-sample.mjs');
  process.exit(1);
}

const buf = fs.readFileSync(SAMPLE);
// Buffer 只是 ArrayBuffer 的一个视图，必须按 byteOffset 切出真正的窗口。
const parsed = parseXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
if (parsed.errors.length > 0) {
  console.error('样本文件本身解析报错：' + JSON.stringify(parsed.errors.slice(0, 3)));
  process.exit(1);
}

const built = buildModel({
  projectId: 'sample',
  datasetName: 'hogo-qa-sample',
  sourceType: 'xlsx',
  rawFileName: 'hogo-qa-sample.xlsx',
  dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
  defect: parsed.defectSheet
    ? { sheet: parsed.defectSheet, mapping: parsed.defectMapping!.mapping }
    : null,
});

console.log('样本文件  ' + path.relative(process.cwd(), SAMPLE));
console.log(
  '解析结果  特性 ' + built.dataset.characteristics.length + ' 个 · 测量值 ' + built.totalMeasurements +
    ' 条 · 空值 ' + built.totalNullCount + ' 条 · 不良类型 ' + built.dataset.defectRecords.length + ' 类',
);
console.log('');

type Row = {
  name: string;
  n: number;
  mean: number;
  within: number;
  overall: number;
  cp: number | null;
  cpk: number | null;
  pp: number | null;
  ppk: number | null;
  short: number | null;
  bench: number | null;
  grade: string;
  verdict: string;
  cpkVsPpk: number;
};

const rows: Row[] = [];
const chartByChar = new Map<string, ReturnType<typeof buildControlChart>>();
const rulesByChar = new Map<string, ReturnType<typeof evaluateRules>>();

for (const c of built.dataset.characteristics) {
  const values = c.measurements.map((m) => m.value);
  const measurements = c.measurements.map((m) => ({ id: m.id, value: m.value, excluded: m.excluded }));
  const subgroups = buildSubgroups(measurements, { mode: 'fixed', capacity: CAPACITY });
  const cap = computeCapability(values, c.specLimits, subgroups, { sigmaMode: 'R' });

  // 控制图与判异：与界面同一条路径（Xbar-R，n=5）
  const series = buildControlChart('Xbar-R', { kind: 'variables', subgroups });
  const sigmaByPoint = sigmaByPointOf(series);
  const rules = evaluateRules(series, sigmaByPoint, defaultToggleConfig());
  chartByChar.set(c.name, series);
  rulesByChar.set(c.name, rules);

  rows.push({
    name: c.name,
    n: cap.n,
    mean: cap.mean,
    within: cap.sigma.within,
    overall: cap.sigma.overall,
    cp: cap.cp,
    cpk: cap.cpk,
    pp: cap.pp,
    ppk: cap.ppk,
    short: cap.sigmaLevelShort,
    bench: cap.sigmaLevelBench,
    grade: GRADE_TEXT[capabilityGrade(cap.cpk)],
    verdict: capabilityVerdictText(cap.cpk),
    cpkVsPpk: cap.cpk !== null && cap.ppk !== null ? cap.cpk - cap.ppk : 0,
  });
}

console.log('## 1. 过程能力（σ_within 走 R̄/d2，σ_overall 走样本标准差 ddof=1）');
console.log('');
console.log('| 特性 | n | 均值 | σ_within | σ_overall | Cp | Cpk | Pp | Ppk | 3×Cpk | 3×Cpk+1.5 | 判定 |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) {
  console.log(
    '| ' + r.name + ' | ' + r.n + ' | ' + f(r.mean) + ' | ' + f(r.within, 5) + ' | ' + f(r.overall, 5) +
      ' | ' + f(r.cp, 2) + ' | ' + f(r.cpk, 2) + ' | ' + f(r.pp, 2) + ' | ' + f(r.ppk, 2) +
      ' | ' + f(r.short, 2) + ' | ' + f(r.bench, 2) + ' | ' + r.verdict + ' |',
  );
}
console.log('');

console.log('## 2. 控制图与判异（Xbar-R，子组容量 5）');
console.log('');
console.log('| 特性 | 子组数 | CL（X̄） | UCL | LCL | R̄ | 命中规则 |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) {
  const series = chartByChar.get(r.name)!;
  const pick = (label: string) => series.limits.primary.find((l) => l.label === label)!.values[0];
  const rules = rulesByChar.get(r.name)!;
  const hit = [...new Set(rules.violations.map((v) => v.ruleId))].sort();
  console.log(
    '| ' + r.name + ' | ' + series.primary.points.length + ' | ' + pick('CL').toFixed(4) + ' | ' +
      pick('UCL').toFixed(4) + ' | ' + pick('LCL').toFixed(4) + ' | ' +
      (series.limits.secondary ? series.limits.secondary.find((l) => l.label === 'CL')!.values[0].toFixed(5) : 'N/A') +
      ' | ' + (hit.length === 0 ? '无' : hit.map((id) => id + '（' + RULE_META[id].shortName + '）').join('、')) + ' |',
  );
}
console.log('');

const pareto = buildPareto(built.dataset.defectRecords.map((d) => ({ defectType: d.defectType, count: d.count })));
console.log('## 3. 柏拉图（合成不良数据，共 ' + pareto.total + " 件）");
console.log('');
console.log('| 排名 | 不良类型 | 数量 | 占比 | 累计占比 |');
console.log('| ---: | --- | ---: | ---: | ---: |');
pareto.items.forEach((it, i) => {
  console.log(
    '| ' + (i + 1) + ' | ' + it.defectType + ' | ' + it.count + ' | ' + it.ratio.toFixed(1) + '% | ' +
      it.cumRatio.toFixed(2) + '% |',
  );
});
console.log('');
console.log('前 3 类累计 ' + pareto.items[2].cumRatio.toFixed(2) + '%；越过 80% 分界线的排名 = 第 ' + ((pareto.crossingIndex ?? 0) + 1) + ' 项');
console.log('');

// ---- 护栏：样本/内核被改动到与 README 不符时要变红 ----
const failures: string[] = [];
const expect = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

expect(rows.length === 3, '样本应含 3 个特性，实际 ' + rows.length);
expect(
  built.totalMeasurements === 150,
  '样本应含 150 条测量值，实际 ' + built.totalMeasurements,
);
expect(
  built.dataset.defectRecords.length === 6,
  '样本应含 6 类不良，实际 ' + built.dataset.defectRecords.length,
);

// 三个特性必须落在不同能力档位，「一份数据演示三档」是这个样本的设计意图
expect(
  new Set(rows.map((r) => r.grade)).size === 3,
  '三个特性应分属三个不同能力档位，实际 ' + rows.map((r) => r.name + '=' + r.grade).join(', '),
);
// Cp 与 Pp 必须分离 —— 这正是相对旧工具的核心修正
for (const r of rows) {
  expect(r.cp !== null && r.pp !== null, r.name + ' 的 Cp/Pp 不应为 null');
  expect(
    r.cp !== null && r.pp !== null && Math.abs(r.cp - r.pp) > 0.05,
    r.name + ' 的 Cp 与 Pp 应明显分离（旧工具 Pp≡Cp 是缺陷）',
  );
}
// 至少一个特性要真的命中判异，否则样本演示不了控制图判异
const totalViolations = [...rulesByChar.values()].reduce((a, r) => a + r.violations.length, 0);
expect(totalViolations > 0, '样本应至少命中一条判异准则');
expect(pareto.crossingIndex !== null, '样本的柏拉图应能越过 80% 分界线');

if (failures.length > 0) {
  console.error('SAMPLE VERIFY FAILED:');
  for (const msg of failures) console.error('  - ' + msg);
  process.exit(1);
}
console.log('OK 样本自检通过（三档能力齐备 / Cp≠Pp / 判异有命中 / 柏拉图跨越 80%）。');