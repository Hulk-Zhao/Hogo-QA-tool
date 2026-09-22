/**
 * 端到端集成测试（T02/T03 对接验收）。
 *
 * 用真实旧工具 xlsx 走完整链路：
 *   读取文件 → parseXlsx（data/importer）→ buildModel → 真实 Dataset
 *   → core 能力分析（3 物料各 50 条）→ 柏拉图（6 类不良）
 *
 * 该测试不触碰 UI，纯粹验证「真实数据层 → core」贯通，作为 T02/T03
 * 对接后链路不回归的护栏。
 */

import { expect, it } from 'vitest';
import { parseXlsx } from '@/data/importer/xlsxImporter';
import { buildModel } from '@/data/importer/buildModel';
import { buildPareto } from '@/core/pareto/pareto';
import { computeCapability } from '@/core/stats/capability';
import { buildSubgroups } from '@/core/stats/subgrouping';

import { describeReal, readRealXlsx } from './realData';

describeReal('端到端：真实 xlsx → 数据层 → core', () => {
  it('导入 → 建模：3 个物料各 50 条 + 6 类不良', () => {
    const parsed = parseXlsx(readRealXlsx());
    expect(parsed.errors).toEqual([]);
    expect(parsed.dimensionSheet!.rows.length).toBe(150);
    expect(parsed.defectSheet!.rows.length).toBe(6);

    const built = buildModel({
      projectId: 'e2e',
      datasetName: 'quality_data',
      sourceType: 'xlsx',
      rawFileName: 'quality_data.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: { sheet: parsed.defectSheet!, mapping: parsed.defectMapping!.mapping },
    });

    // 3 个物料各 50 条
    expect(built.dataset.characteristics.length).toBe(3);
    for (const c of built.dataset.characteristics) {
      expect(c.measurements.length).toBe(50);
    }
    expect(built.totalMeasurements).toBe(150);
    expect(built.totalNullCount).toBe(0);

    // 6 类不良与真实值一致
    const counts: Record<string, number> = {};
    for (const d of built.dataset.defectRecords) {
      counts[d.defectType] = d.count;
    }
    expect(counts).toEqual({
      划伤: 320,
      尺寸超差: 215,
      毛边: 148,
      色差: 92,
      变形: 45,
      异物: 18,
    });
  });

  it('能力分析：读得到真实 3 物料，且 Ppk 与基准文档 Cpk 吻合', () => {
    const parsed = parseXlsx(readRealXlsx());
    const built = buildModel({
      projectId: 'e2e',
      datasetName: 'quality_data',
      sourceType: 'xlsx',
      rawFileName: 'quality_data.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: null,
    });

    // 基准：外壳长度 Ppk≈2.8530、转轴直径≈1.2525、安装孔径≈1.8280（整体 σ 口径）
    const expected: Record<string, number> = {
      外壳长度: 2.853023,
      转轴直径: 1.252515,
      安装孔径: 1.827964,
    };

    for (const c of built.dataset.characteristics) {
      const measurements = c.measurements.map((m) => ({
        id: m.id,
        value: m.value,
        excluded: m.excluded,
      }));
      const values = c.measurements.map((m) => m.value);
      const subgroups = buildSubgroups(measurements, { mode: 'fixed', capacity: 5 });
      const cap = computeCapability(values, c.specLimits, subgroups, { useImrFallback: true });
      expect(cap.n).toBe(50);
      // Ppk 必须与旧工具基准 Cpk（整体 σ 口径）吻合
      expect(cap.ppk).not.toBeNull();
      expect(cap.ppk!).toBeCloseTo(expected[c.name], 3);
      // Cp 与 Pp 分离（修正旧工具 std_sub=std_total 的核心缺陷）
      expect(cap.cp).not.toBeNull();
      expect(cap.pp).not.toBeNull();
    }
  });

  it('柏拉图：读得到 6 类不良，前 3 项累计跨过 80%', () => {
    const parsed = parseXlsx(readRealXlsx());
    const built = buildModel({
      projectId: 'e2e',
      datasetName: 'quality_data',
      sourceType: 'xlsx',
      rawFileName: 'quality_data.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: { sheet: parsed.defectSheet!, mapping: parsed.defectMapping!.mapping },
    });

    const pareto = buildPareto(
      built.dataset.defectRecords.map((d) => ({
        defectType: d.defectType,
        count: d.count,
        category: d.category,
      })),
      80,
      '其他',
      0,
    );
    expect(pareto.total).toBe(838);
    expect(pareto.items.length).toBe(6);
    expect(pareto.items[0].defectType).toBe('划伤');
    expect(pareto.items[0].count).toBe(320);
    // 第 3 项（毛边）累计跨过 80%
    expect(pareto.crossingIndex).toBe(2);
    expect(pareto.items[2].defectType).toBe('毛边');
    expect(pareto.items[2].cumRatio).toBeCloseTo(81.5, 1);
  });
});
