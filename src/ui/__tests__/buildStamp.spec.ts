/**
 * buildStamp 测试：产物自证版本（防止「用户打开的是旧产物」重复消耗排障成本）。
 *
 * 证伪立场：
 * - 删掉 'dev' 回落 → 测试环境读取未定义标识符，用例直接抛 ReferenceError 变红；
 * - 删掉 vite define → 真机产物上 `app-build-stamp` 退化为 dev，
 *   `.probe/ai400-verify.mjs` 的场景 D 变红（这就是本函数的端到端守卫）。
 */
import { describe, expect, it } from 'vitest';
import { buildStamp } from '@/ui/buildStamp';

describe('buildStamp', () => {
  it('未注入 __BUILD_STAMP__（vitest/开发态）→ 回落 dev，且不抛异常', () => {
    expect(buildStamp()).toBe('dev');
  });

  it('返回值恒为非空字符串（可直接渲染进 UI）', () => {
    const stamp = buildStamp();
    expect(typeof stamp).toBe('string');
    expect(stamp.length).toBeGreaterThan(0);
  });
});
