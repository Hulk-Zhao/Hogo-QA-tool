/**
 * 真实基准 xlsx 的定位 —— 开源后**不依赖作者本机的私有路径**。
 *
 * 顺序：环境变量 `HOGO_REAL_XLSX` → 仓库内 fixture（`fixtures/quality_data.xlsx`，随仓库提供）。
 * 两者都拿不到时 `REAL_XLSX` 为 `null`，调用方用 `describeReal` 整组跳过 ——
 * 让**任何新克隆 / CI 都保持绿色**，而不是红一片让人误以为代码坏了。
 *
 * fixture 与原基准文件**内容一致**（dimension 150 行「物料名称/测量值/USL/LSL」，
 * defect 6 行「不良类型/不良数量」），因此断言口径不变。
 * 想改用自己的真实文件：`HOGO_REAL_XLSX=/path/to/quality_data.xlsx npm test`。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';

/** 仓库内 fixture 的绝对路径。 */
export const REPO_FIXTURE_XLSX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'quality_data.xlsx',
);

/** 解析基准 xlsx 路径；都没有时返回 null（调用方自行跳过）。 */
export function resolveRealXlsx(): string | null {
  const fromEnv = (process.env.HOGO_REAL_XLSX ?? '').trim();
  if (fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  if (existsSync(REPO_FIXTURE_XLSX)) {
    return REPO_FIXTURE_XLSX;
  }
  return null;
}

/** 本次运行采用的基准文件；`null` = 没有可用的基准数据。 */
export const REAL_XLSX: string | null = resolveRealXlsx();

/** 读取基准 xlsx 为 ArrayBuffer（仅在 `REAL_XLSX` 非空时调用）。 */
export function readRealXlsx(): ArrayBuffer {
  if (REAL_XLSX === null) {
    throw new Error('未找到基准 xlsx：请设置 HOGO_REAL_XLSX 或提供 fixtures/quality_data.xlsx');
  }
  const buf = readFileSync(REAL_XLSX);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 有基准数据才注册的分组；否则整组 skip。 */
export const describeReal = REAL_XLSX === null ? describe.skip : describe;