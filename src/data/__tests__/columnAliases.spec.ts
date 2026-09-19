/**
 * columnAliases 全角列名识别测试（本轮 P2-C）。
 *
 * 缺陷背景：现场表格常带全角输入法残留（`ＵＳＬ`/`ＬＳＬ`/`ｖａｌｕｅ`）与全角空格。
 * 此前只处理了全角空格，全角字母数字一律识别不出 → 用户被要求「改列名」，
 * 而 PRD P0-15 的初衷恰恰是**避免要求用户改列名**。
 *
 * 证伪立场：把 `normalizeColumnName` 的全角转换去掉，第 1/2/4 组用例变红。
 */

import { describe, expect, it } from 'vitest';
import { normalizeColumnName, resolveRole, toHalfWidthAscii } from '../importer/columnAliases';
import { parseCsv } from '../importer/csvImporter';

describe('toHalfWidthAscii —— 全角转半角', () => {
  it('全角字母数字与符号 → ASCII', () => {
    expect(toHalfWidthAscii('ＵＳＬ')).toBe('USL');
    expect(toHalfWidthAscii('ｖａｌｕｅ')).toBe('value');
    expect(toHalfWidthAscii('１２３')).toBe('123');
    expect(toHalfWidthAscii('Ａ－Ｚ')).toBe('A-Z');
  });

  it('全角空格（U+3000）→ 半角空格；中文与半角字符不受影响', () => {
    expect(toHalfWidthAscii('　测量值　')).toBe(' 测量值 ');
    expect(toHalfWidthAscii('外壳长度')).toBe('外壳长度');
  });
});

describe('normalizeColumnName —— 规范化', () => {
  it('全角 + 大小写 + 空格统一归一', () => {
    expect(normalizeColumnName('ＵＳＬ')).toBe('usl');
    expect(normalizeColumnName('  ｕｓｌ  ')).toBe('usl');
    expect(normalizeColumnName('　规格上限　')).toBe('规格上限');
    expect(normalizeColumnName('值  域')).toBe('值 域');
  });
});

describe('resolveRole —— 全角列名解析为角色', () => {
  it('全角英文别名可识别', () => {
    expect(resolveRole('ＵＳＬ')).toBe('usl');
    expect(resolveRole('ＬＳＬ')).toBe('lsl');
    expect(resolveRole('ｖａｌｕｅ')).toBe('value');
    expect(resolveRole('Ｍａｔｅｒｉａｌ')).toBe('material');
    expect(resolveRole('Ｔａｒｇｅｔ')).toBe('target');
    expect(resolveRole('Ｓｕｂｇｒｏｕｐ')).toBe('subgroup');
  });

  it('回归：半角别名与中文别名行为不变', () => {
    expect(resolveRole('USL')).toBe('usl');
    expect(resolveRole('usl')).toBe('usl');
    expect(resolveRole('规格上限')).toBe('usl');
    expect(resolveRole('测量值')).toBe('value');
    expect(resolveRole('物料名称')).toBe('material');
    expect(resolveRole('乱七八糟')).toBeNull();
  });
});

describe('集成：全角表头的 CSV 也能自动映射并导入', () => {
  it('ＵＳＬ / ＬＳＬ 全角表头 → 映射到位、无缺失角色、无行级错误', () => {
    const csv = [
      '物料名称,测量值,ＵＳＬ,ＬＳＬ',
      '外壳长度,50.0091,50.2,49.8',
      '外壳长度,49.9688,50.2,49.8',
    ].join('\n');
    const out = parseCsv(csv);
    expect(out.mapping.mapping.material).toBe(0);
    expect(out.mapping.mapping.value).toBe(1);
    expect(out.mapping.mapping.usl).toBe(2);
    expect(out.mapping.mapping.lsl).toBe(3);
    expect(out.mapping.missingRoles).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.sheet.rows.length).toBe(2);
  });
});
