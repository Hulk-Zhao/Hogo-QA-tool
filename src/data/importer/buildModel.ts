/**
 * buildModel：解析结果 → 领域实体（Dataset / Characteristic / Measurement / DefectRecord）。
 *
 * 出处：架构文档 §4.1；PRD §8 数据模型。
 * - dimension：按「物料名称」聚合为多个 Characteristic；USL/LSL 取该物料
 *   首行的值（现场随行重复）→ 写入 specLimits。
 * - defect：每行一个 DefectRecord。
 * - 空值（缺失测量值）不计入 measurements，仅累加 nullCount（架构 §8.3）。
 */

import { HogoError } from '../errors';
import type {
  Characteristic,
  Dataset,
  DefectRecord,
  Measurement,
} from '../schema';
import { genId, nowIso } from '../internal';
import { cellToString, parseCountCell, parseNumericCell } from './cellParsing';
import type { ColumnMapping, ImportSourceType, ParsedSheet } from './types';

/** buildModel 输入。 */
export interface BuildModelInput {
  projectId: string;
  datasetName: string;
  sourceType: ImportSourceType;
  rawFileName: string;
  /** dimension 表与映射（可空：仅导入 defect 时）。 */
  dimension: { sheet: ParsedSheet; mapping: ColumnMapping } | null;
  /** defect 表与映射（可空）。 */
  defect: { sheet: ParsedSheet; mapping: ColumnMapping } | null;
}

/** buildModel 输出。 */
export interface BuildModelOutput {
  dataset: Dataset;
  /** 全数据集缺失测量值总数。 */
  totalNullCount: number;
  /** 测量值总条数（有效值）。 */
  totalMeasurements: number;
}

/** 单个物料的聚合中间态。 */
interface MaterialAcc {
  name: string;
  usl: number | null;
  lsl: number | null;
  target: number | null;
  uslSeen: boolean;
  lslSeen: boolean;
  targetSeen: boolean;
  values: { value: number; subgroup: string | null; batch: string | null }[];
  nullCount: number;
}

/**
 * 构造领域模型。
 *
 * @throws {HogoError} IMPORT_EMPTY（无任何测量值且无不良记录）
 * @throws {HogoError} IMPORT_PARSE_FAILED（必需映射缺失）
 */
export function buildModel(input: BuildModelInput): BuildModelOutput {
  const datasetId = genId('ds');
  const characteristics: Characteristic[] = [];
  let totalNullCount = 0;
  let totalMeasurements = 0;

  if (input.dimension) {
    const { sheet, mapping } = input.dimension;
    const materialCol = mapping.material;
    const valueCol = mapping.value;
    if (materialCol === undefined || valueCol === undefined) {
      throw new HogoError('IMPORT_PARSE_FAILED', 'dimension 映射缺失物料名称或测量值列。', { mapping });
    }
    const materials = new Map<string, MaterialAcc>();
    const order: string[] = [];

    for (let i = 0; i < sheet.rows.length; i += 1) {
      const row = sheet.rows[i];
      const name = cellToString(row[materialCol]);
      if (name.length === 0) {
        continue; // 空物料行已在解析阶段报错，这里跳过。
      }
      let acc = materials.get(name);
      if (!acc) {
        acc = {
          name,
          usl: null,
          lsl: null,
          target: null,
          uslSeen: false,
          lslSeen: false,
          targetSeen: false,
          values: [],
          nullCount: 0,
        };
        materials.set(name, acc);
        order.push(name);
      }
      // USL/LSL 以每物料首行为准（现场随行重复）。
      if (!acc.uslSeen && mapping.usl !== undefined && mapping.usl >= 0) {
        const p = parseNumericCell(row[mapping.usl]);
        acc.usl = p.value;
        acc.uslSeen = true;
      }
      if (!acc.lslSeen && mapping.lsl !== undefined && mapping.lsl >= 0) {
        const p = parseNumericCell(row[mapping.lsl]);
        acc.lsl = p.value;
        acc.lslSeen = true;
      }
      if (!acc.targetSeen && mapping.target !== undefined && mapping.target >= 0) {
        const p = parseNumericCell(row[mapping.target]);
        acc.target = p.value;
        acc.targetSeen = true;
      }

      const subgroup =
        mapping.subgroup !== undefined && mapping.subgroup >= 0
          ? cellToString(row[mapping.subgroup]) || null
          : null;
      const batch =
        mapping.batch !== undefined && mapping.batch >= 0
          ? cellToString(row[mapping.batch]) || null
          : null;

      const parsed = parseNumericCell(row[valueCol]);
      if (parsed.value === null) {
        acc.nullCount += 1;
        continue; // 缺失值不生成 Measurement（架构 §8.3）。
      }
      acc.values.push({ value: parsed.value, subgroup, batch });
    }

    for (const name of order) {
      const acc = materials.get(name)!;
      const charId = genId('char');
      const measurements: Measurement[] = acc.values.map((v) => ({
        id: genId('meas'),
        characteristicId: charId,
        value: v.value,
        subgroupId: v.subgroup,
        timestamp: null,
        batch: v.batch,
        excluded: false,
        excludeReason: null,
      }));
      const characteristic: Characteristic = {
        id: charId,
        datasetId,
        name: acc.name,
        specLimits: {
          usl: acc.usl,
          lsl: acc.lsl,
          target: acc.target,
          unit: '',
        },
        measurements,
        subgroups: [],
        nullCount: acc.nullCount,
        outlierFlags: [],
        preprocessConfigRef: null,
        measurementBlobRef: null,
      };
      characteristics.push(characteristic);
      totalNullCount += acc.nullCount;
      totalMeasurements += measurements.length;
    }
  }

  const defectRecords: DefectRecord[] = [];
  if (input.defect) {
    const { sheet, mapping } = input.defect;
    const typeCol = mapping.defectType;
    const countCol = mapping.defectCount;
    if (typeCol === undefined || countCol === undefined) {
      throw new HogoError('IMPORT_PARSE_FAILED', 'defect 映射缺失不良类型或不良数量列。', { mapping });
    }
    for (const row of sheet.rows) {
      const defectType = cellToString(row[typeCol]);
      if (defectType.length === 0) continue;
      const parsed = parseCountCell(row[countCol]);
      if (parsed.value === null) continue; // 缺失/非法已在解析阶段报错。
      defectRecords.push({
        id: genId('def'),
        datasetId,
        defectType,
        count: parsed.value,
        category: null,
      });
    }
  }

  if (characteristics.length === 0 && defectRecords.length === 0) {
    throw new HogoError('IMPORT_EMPTY', '导入内容不含任何有效测量值或不良记录。', {});
  }

  const dataset: Dataset = {
    id: datasetId,
    projectId: input.projectId,
    name: input.datasetName,
    sourceType: input.sourceType,
    importedAt: nowIso(),
    rawFileName: input.rawFileName,
    characteristics,
    defectRecords,
  };

  return { dataset, totalNullCount, totalMeasurements };
}
