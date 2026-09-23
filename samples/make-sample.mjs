/**
 * make-sample.mjs —— 生成 README 用的样本数据 `samples/hogo-qa-sample.xlsx`。
 *
 * 为什么要有它：README 里那张「样本数据 → 计算结果」的表必须**可复算**。
 * 二进制 xlsx 没法在 diff 里被 review，所以入库的是两份：
 *   - 脚本（决定数据长什么样，改了要重新跑）；
 *   - 产物（保证任何人 `npm ci` 之后立刻能导入试用，不必先跑脚本）。
 *
 * 数据刻意做成「一份数据同时演示多个能力」的形状：
 *   - 3 个特性，覆盖「能力充足 / 临界 / 不足」三档 —— 用于多特性 Cpk 汇总对比；
 *   - 子组**内**噪声小、子组**间**有慢漂移 → σ_within < σ_overall，
 *     于是 Cp > Pp、Cpk > Ppk。这正是旧工具「Pp 恒等于 Cp」会抹掉的信息；
 *   - 人为注入「整段均值阶跃 / 单点尖峰 / 连续上升」，让 12 条判异准则真的有命中；
 *   - 6 类不良构成一条能越过 80% 分界线的柏拉图曲线。
 *
 * 数据是**合成**的（不含任何真实产线数据），噪声用固定种子的 mulberry32，
 * 因此同一个 Node 版本跑两次产物逐字节一致。
 *
 * 用法：
 *   node samples/make-sample.mjs
 */
import path from 'node:path';

import XLSX from 'xlsx';

const OUT = path.join(import.meta.dirname, 'hogo-qa-sample.xlsx');

/** 每个特性的测量点数（3 × 50 = 150 条，与 README 表格一致）。 */
const COUNT = 50;

/** mulberry32：确定性 PRNG，返回 [0,1)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态（Box-Muller），输入为 [0,1) 均匀随机源。 */
function makeNormal(rnd) {
  return () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
}

/**
 * 三个特性的「剧本」。所有非噪声因素都写在这里，脚本本身不含隐式随机性。
 *
 *   base    标称中心
 *   noise   子组内噪声 σ（决定 R̄ → σ_within → Cp/Cpk）
 *   drift   每 10 个点叠加一次的均值漂移（决定 σ_overall → Pp/Ppk）
 *   shift   整段均值阶跃 { at, delta }
 *   ramp    连续上升 { at, step, points }
 *   spikes  单点尖峰 { 下标: 偏移量 }
 */
const PLAN = [
  {
    name: '外壳长度',
    unit: 'mm',
    decimals: 4,
    lsl: 49.8,
    usl: 50.2,
    base: 50.0,
    noise: 0.03,
    drift: 0.012,
    shift: { at: 25, delta: 0.055 },
    ramp: null,
    spikes: { 17: 0.11 },
    seed: 20260919,
  },
  {
    name: '转轴直径',
    unit: 'mm',
    decimals: 4,
    lsl: 11.98,
    usl: 12.02,
    base: 12.0,
    noise: 0.005,
    drift: 0.0015,
    shift: null,
    ramp: null,
    spikes: {},
    seed: 20260920,
  },
  {
    name: '端面跳动',
    unit: 'mm',
    decimals: 4,
    lsl: 0.02,
    usl: 0.08,
    base: 0.0535,
    noise: 0.0092,
    drift: 0.0022,
    shift: null,
    ramp: { at: 30, step: 0.0035, points: 6 },
    spikes: {},
    seed: 20260921,
  },
];

/** 按「剧本」生成一个特性的测量值序列。 */
function generate(spec) {
  const rnd = mulberry32(spec.seed);
  const normal = makeNormal(rnd);
  const round = (v) => Number(v.toFixed(spec.decimals));
  const values = [];
  for (let i = 0; i < COUNT; i += 1) {
    let v = spec.base + normal() * spec.noise;
    v += Math.floor(i / 10) * spec.drift;
    if (spec.shift && i >= spec.shift.at) {
      v += spec.shift.delta;
    }
    if (spec.ramp && i >= spec.ramp.at && i < spec.ramp.at + spec.ramp.points) {
      v += (i - spec.ramp.at + 1) * spec.ramp.step;
    }
    if (spec.spikes[i] !== undefined) {
      v += spec.spikes[i];
    }
    values.push(round(v));
  }
  return values;
}

/** 6 类不良（合成），用于柏拉图：前 3 类累计越过 80% 分界线。 */
const DEFECTS = [
  ['毛刺', 42],
  ['尺寸超差', 27],
  ['划伤', 18],
  ['变形', 9],
  ['气孔', 6],
  ['其他', 5],
];

const dimension = [['物料名称', '测量值', 'USL', 'LSL', '单位']];
const rows = [];
for (const spec of PLAN) {
  const values = generate(spec);
  for (const v of values) {
    dimension.push([spec.name, v, spec.usl, spec.lsl, spec.unit]);
  }
  rows.push({ name: spec.name, values, lsl: spec.lsl, usl: spec.usl });
}

const defect = [['不良类型', '不良数量'], ...DEFECTS];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dimension), '尺寸数据');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(defect), '不良数据');
XLSX.writeFile(wb, OUT, { bookType: 'xlsx' });

console.log('written ' + OUT);
console.log(
  'characteristics=' + rows.length +
    ' measurements=' + rows.reduce((a, r) => a + r.values.length, 0) +
    ' defectTypes=' + DEFECTS.length,
);