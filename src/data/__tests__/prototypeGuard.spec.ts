// @vitest-environment jsdom
/**
 * prototypeGuard 回归测试（永久）—— 本轮 P1-C「xlsx 原型污染防护」。
 *
 * 风险出处：`xlsx@0.18.5` 存在原型污染漏洞（CVE-2023-30533），
 * 修复版未发布到 npm registry，短期无法靠升级消除，因此在**出口**做卫生。
 *
 * 证伪立场（破坏实现必须变红）：
 * - 去掉 `purgePrototypePollution` 的删除动作 → 第 1 组与集成用例变红；
 * - 去掉 `toSafeCell` 白名单 → 第 2 组的对象 / 布尔用例变红；
 * - 集成用例用 `vi.doMock` 让「解析器」在 read 期间真实污染 `Object.prototype`，
 *   断言污染被清理 **且** 结果里出现安全告警 —— 若守卫没接线，两条断言同时变红。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  purgePrototypePollution,
  snapshotObjectPrototype,
  toSafeCell,
} from '@/data/importer/prototypeGuard';

/** 清理测试期间可能残留的注入键（防止污染跨用例泄漏）。 */
afterEach(() => {
  Reflect.deleteProperty(Object.prototype, '__polluted');
  Reflect.deleteProperty(Object.prototype, 'pollutedByFile');
  vi.doUnmock('xlsx');
  vi.resetModules();
});

describe('purgePrototypePollution —— 原型污染出口清理', () => {
  it('删除快照之后新增的 Object.prototype 属性，并回报键名', () => {
    const baseline = snapshotObjectPrototype();
    (Object.prototype as Record<string, unknown>).__polluted = 'pwned';
    expect('__polluted' in ({})).toBe(true);

    const purged = purgePrototypePollution(baseline);

    expect(purged).toContain('__polluted');
    // 关键：不仅回报，属性必须真的没了（否则对象上处处可见攻击者注入值）。
    expect('__polluted' in ({})).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('__polluted');
  });

  it('不误删快照中已存在的属性（宿主 polyfill / 内置方法保持完好）', () => {
    const baseline = snapshotObjectPrototype();
    expect(purgePrototypePollution(baseline)).toEqual([]);
    expect(typeof ({} as Record<string, unknown>).toString).toBe('function');
  });

  it('重复调用是幂等的（第二次没有可清理项）', () => {
    const baseline = snapshotObjectPrototype();
    (Object.prototype as Record<string, unknown>).__polluted = 1;
    expect(purgePrototypePollution(baseline)).toEqual(['__polluted']);
    expect(purgePrototypePollution(baseline)).toEqual([]);
  });
});

describe('toSafeCell —— 单元格出口白名单', () => {
  it('放行 string / number / null', () => {
    expect(toSafeCell('外壳长度')).toBe('外壳长度');
    expect(toSafeCell(9.85)).toBe(9.85);
    expect(toSafeCell(0)).toBe(0);
    expect(toSafeCell(null)).toBeNull();
  });

  it('boolean → 字符串（此前会以「类型谎言」流入 RawCell 并在 cellToString 抛错）', () => {
    expect(toSafeCell(true)).toBe('true');
    expect(toSafeCell(false)).toBe('false');
  });

  it('对象 / 数组 / 函数 / undefined → null（非预期结构一律不许进入领域层）', () => {
    expect(toSafeCell({ a: 1 })).toBeNull();
    expect(toSafeCell(['a'])).toBeNull();
    expect(toSafeCell(() => 1)).toBeNull();
    expect(toSafeCell(undefined)).toBeNull();
  });

  it('Date → ISO 字符串（防御性路径）', () => {
    expect(toSafeCell(new Date('2026-09-19T00:00:00.000Z'))).toBe('2026-09-19T00:00:00.000Z');
  });
});

describe('parseXlsx 集成：解析期间的污染会被拦截 + 清理 + 告警', () => {
  it('模拟恶意工作簿在 read 时污染 Object.prototype → 被清理且写入 warnings', async () => {
    vi.resetModules();
    vi.doMock('xlsx', () => ({
      read: () => {
        // 模拟 CVE-2023-30533：解析过程往 Object.prototype 写属性。
        (Object.prototype as Record<string, unknown>).pollutedByFile = 'pwned';
        return { SheetNames: ['dimension'], Sheets: { dimension: {} } };
      },
      utils: {
        sheet_to_json: () => [
          ['物料名称', '测量值'],
          ['外壳长度', 9.8],
          ['外壳长度', 9.9],
        ],
      },
    }));

    const { parseXlsx } = await import('@/data/importer/xlsxImporter');
    const out = parseXlsx(new ArrayBuffer(8));

    // 1) 污染已被清理（去掉守卫后这里会是 true）。
    expect('pollutedByFile' in ({})).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('pollutedByFile');
    // 2) 用户可见告警，而不是静默吞掉（去掉守卫后不会有这条）。
    const text = out.warnings.join('|');
    expect(text).toContain('原型');
    expect(text).toContain('pollutedByFile');
    // 3) 正常解析结果不受影响（不是用「拒绝导入」换取安全）。
    expect(out.dimensionSheet?.rows.length).toBe(2);
  });
});
