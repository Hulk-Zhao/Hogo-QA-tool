/**
 * opfsStore：测量值的大数组读写封装。
 *
 * 策略（架构文档 §7.4）：大批量测量值优先写入 OPFS 文件；OPFS 不可用时
 * 由 Repository 降级为「内联进 IndexedDB」（measurementBlobRef=null）。
 * 本模块只负责「给定 FileStore，把数值数组序列化为文本文件」。
 */

import type { FileStore } from './adapters';
import { HogoError } from '../errors';

/** OPFS 文件扩展名。 */
const REF_SUFFIX = '.json';

/** 由 blobRef（文件名）读取数值数组。 */
export async function readValuesFromFile(fileStore: FileStore, blobRef: string): Promise<number[]> {
  const text = await fileStore.readText(blobRef);
  if (text === null) {
    throw new HogoError('STORAGE_UNAVAILABLE', `OPFS 文件缺失：${blobRef}`, { blobRef });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new HogoError('STORAGE_UNAVAILABLE', `OPFS 文件内容非合法 JSON：${blobRef}`, {
      blobRef,
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new HogoError('STORAGE_UNAVAILABLE', `OPFS 文件不是数值数组：${blobRef}`, { blobRef });
  }
  return parsed.map((v) => Number(v));
}

/** 将数值数组写入 OPFS 文件（覆盖）。 */
export async function writeValuesToFile(
  fileStore: FileStore,
  blobRef: string,
  values: number[],
): Promise<void> {
  await fileStore.writeText(blobRef, JSON.stringify(values));
}

/** 删除 OPFS 文件（幂等）。 */
export async function deleteFile(fileStore: FileStore, blobRef: string): Promise<void> {
  await fileStore.delete(blobRef);
}

/** 由特性 id 派生一个稳定的 OPFS 文件名。 */
export function makeBlobRef(characteristicId: string): string {
  const safe = characteristicId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `meas_${safe}${REF_SUFFIX}`;
}
