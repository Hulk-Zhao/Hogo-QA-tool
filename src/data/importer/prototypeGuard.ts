/**
 * prototypeGuard —— 第三方解析器的**出口卫生**（本轮 P1-C）。
 *
 * 背景（真实风险，非理论）：
 * 导入器依赖 `xlsx@0.18.5`。SheetJS 在该版本存在原型污染漏洞
 * （CVE-2023-30533，修复版 0.19.3+ 未发布到 npm registry，只在其自有 CDN
 * 提供），即**精心构造的 xlsx 文件可以让解析过程往 `Object.prototype` 上写属性**。
 * 一旦写入成功，污染是进程级的：页面上任何 `obj.someKey` 都可能命中攻击者
 * 注入的值，且不会报错——属于「静默且影响面大」的一类缺陷。
 *
 * 本模块提供两道**与 SheetJS 版本无关**的防线：
 * 1. `snapshotObjectPrototype` + `purgePrototypePollution`：解析前后对比
 *    `Object.prototype` 的自有属性集，把新增属性删掉并回报键名（供 UI 告警）；
 * 2. `toSafeCell`：单元格出口白名单——只放行 `string | number | null`，
 *    对象 / 数组 / 函数一律转 null，避免非预期结构进入领域层。
 *
 * 为什么用「出口清理」而不是直接升级依赖：npm 上的可安装版本就是 0.18.5
 * （0.20.x 已迁出 npm），迁移到 `exceljs` 属中期动作（见记忆第九节的风险项）。
 * 出口守卫的价值在于：无论解析器内部如何被攻破，**领域层拿到的都是干净的**。
 */

import type { RawCell } from './types';

/**
 * 快照 `Object.prototype` 的自有属性名（解析前调用）。
 *
 * 只取自有属性名（含不可枚举），因为污染通常通过 `Object.prototype.__proto__`
 * 或 `Object.defineProperty` 注入新键。
 *
 * @returns 属性名快照
 */
export function snapshotObjectPrototype(): string[] {
  return Object.getOwnPropertyNames(Object.prototype);
}

/**
 * 清理相对快照**新增**的 `Object.prototype` 属性（解析后调用）。
 *
 * 保守立场：只删除「快照里没有、现在有」的键——既不会误删宿主环境自带的属性
 * （例如测试框架 / polyfill 注入的键），也不会漏掉真正的污染。
 *
 * @param snapshot `snapshotObjectPrototype()` 的返回值
 * @returns 被删除的键名列表（空数组表示未检测到污染）
 */
export function purgePrototypePollution(snapshot: readonly string[]): string[] {
  const known = new Set(snapshot);
  const purged: string[] = [];
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (known.has(key)) {
      continue;
    }
    // delete 可能因属性不可配置而失败：失败也要回报，让上层能告警。
    Reflect.deleteProperty(Object.prototype, key);
    purged.push(key);
  }
  return purged;
}

/**
 * 单元格出口白名单：只放行 `string | number | null`。
 *
 * - `boolean` → 转字符串（SheetJS 的 `t:'b'` 单元格会返回布尔值，
 *   此前会以「类型谎言」流入 `RawCell`，在 `cellToString` 里触发 `.trim()`
 *   不存在而抛错）；
 * - `Date` → ISO 字符串（防御性：万一启用 cellDates）；
 * - 其他（对象 / 数组 / 函数 / undefined）→ `null`（当作空单元格）。
 *
 * @param value 原始单元格值
 * @returns 合法 RawCell
 */
export function toSafeCell(value: unknown): RawCell {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}
