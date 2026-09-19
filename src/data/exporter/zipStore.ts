/**
 * zipStore —— 最小 ZIP 读写（仅 STORE，不压缩）。
 *
 * 为什么需要它：用户要求「导出 Excel 也带图片」，而 `xlsx@0.18.5` 社区版
 * 的 `ws['!images']` 是 SheetJS **Pro** 特性，社区版写出时不会生成
 * `xl/media/*`（实测：产物里没有 media 目录，Excel 打开后一张图都没有）。
 * 因此图片必须由我们自己写进 OOXML 包：把 xlsx 当 ZIP 拆开、补 drawing/media
 * 部件、再重新打包。
 *
 * 为什么只支持 STORE：读回时要解开 DEFLATE 才能改 `sheetN.xml` 与
 * `[Content_Types].xml`，而浏览器侧没有**同步**的 inflate（DecompressionStream
 * 是异步的）。所以导出处统一用 `compression: false` 写产物（SheetJS 支持），
 * 于是这里可以全程同步、零依赖。实测代价：4 sheet 的日报未压缩包比压缩包大约
 * 2.4 倍，但绝对量只有几十 KB，相比内嵌的 PNG（数百 KB）可以忽略。
 *
 * 遇到带 DEFLATE 或 data descriptor 的包会**显式抛错**，绝不静默产出坏文件。
 */

/** 一个 ZIP 条目（仅文件，不支持目录条目）。 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** CRC32 查表（IEEE 802.3，ZIP 用的就是它）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param data 字节
 * @returns 无符号 32 位 CRC
 */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 归一化输入为 Uint8Array（不改动原数据）。 */
function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array
    ? input
    : new Uint8Array(input);
}

/**
 * 解析 ZIP 条目（按本地文件头顺序扫描）。
 *
 * @param input xlsx 二进制
 * @returns 条目列表（含文件名与原始字节）
 */
export function readZipEntries(input: ArrayBuffer | Uint8Array): ZipEntry[] {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];

  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    if (view.getUint32(offset, true) !== LOCAL_SIG) {
      // 走到中央目录就收工；中间出现别的东西说明包结构不符预期。
      if (view.getUint32(offset, true) === CENTRAL_SIG) {
        break;
      }
      throw new Error('ZIP 结构不符预期：未找到本地文件头。');
    }
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));

    if (method !== 0) {
      throw new Error(`ZIP 条目「${name}」是压缩存储（DEFLATE），本工具只支持 STORE。`);
    }
    if ((flags & 0x08) !== 0) {
      throw new Error(`ZIP 条目「${name}」使用 data descriptor，本工具不支持。`);
    }

    const dataStart = offset + 30 + nameLen + extraLen;
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + compSize) });
    offset = dataStart + compSize;
  }

  if (entries.length === 0) {
    throw new Error('ZIP 解析失败：没有任何条目。');
  }
  return entries;
}

/**
 * 打包为 ZIP（全部 STORE，重算 CRC32）。
 *
 * @param entries 条目列表
 * @returns ZIP 二进制
 */
export function writeZip(entries: ZipEntry[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => ({
    nameBytes: encoder.encode(e.name),
    data: e.data,
    crc: crc32(e.data),
  }));

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const total = localSize + centralSize + 22;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const centralOffsets: number[] = [];

  for (const e of prepared) {
    centralOffsets.push(offset);
    view.setUint32(offset, LOCAL_SIG, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true); // flags
    view.setUint16(offset + 8, 0, true); // method = STORE
    view.setUint16(offset + 10, 0, true); // mod time
    view.setUint16(offset + 12, 0x21, true); // mod date = 1980-01-01
    view.setUint32(offset + 14, e.crc, true);
    view.setUint32(offset + 18, e.data.length, true);
    view.setUint32(offset + 22, e.data.length, true);
    view.setUint16(offset + 26, e.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra len
    out.set(e.nameBytes, offset + 30);
    out.set(e.data, offset + 30 + e.nameBytes.length);
    offset += 30 + e.nameBytes.length + e.data.length;
  }

  const centralStart = offset;
  prepared.forEach((e, i) => {
    view.setUint32(offset, CENTRAL_SIG, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0x21, true);
    view.setUint32(offset + 16, e.crc, true);
    view.setUint32(offset + 20, e.data.length, true);
    view.setUint32(offset + 24, e.data.length, true);
    view.setUint16(offset + 28, e.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra
    view.setUint16(offset + 32, 0, true); // comment
    view.setUint16(offset + 34, 0, true); // disk
    view.setUint16(offset + 36, 0, true); // internal attrs
    view.setUint32(offset + 38, 0, true); // external attrs
    view.setUint32(offset + 42, centralOffsets[i], true);
    out.set(e.nameBytes, offset + 46);
    offset += 46 + e.nameBytes.length;
  });

  view.setUint32(offset, EOCD_SIG, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);
  offset += 22;

  if (offset !== total) {
    throw new Error('ZIP 打包长度自检失败。');
  }
  return out.buffer;
}
