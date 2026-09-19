/**
 * 构建标识（buildStamp）——让**产物本身**能回答「我运行的是哪一版」。
 *
 * 背景（真实事故，已发生两次）：用户双击的是修复前的旧离线包 `dist/index.html`，
 * 于是同一个现象（打印无图表）被重复报障，排障只能靠比对文件时间戳与产物内字符串，
 * 成本极高且结论靠推断。
 *
 * 注入方式：vite 配置在**构建时**注入 `__BUILD_STAMP__`
 * （见 `vite.config.ts` 与 `vite.config.offline.ts`）。
 * 未注入的环境（vitest / 开发态）回落 `'dev'`；用 `typeof` 判断而非直接读取，
 * 避免未定义标识符抛 ReferenceError。
 *
 * @returns 形如 `2026-09-19 11:12` 的构建时间；未注入时为 `'dev'`
 */
declare const __BUILD_STAMP__: string;

export function buildStamp(): string {
  return typeof __BUILD_STAMP__ === 'string' && __BUILD_STAMP__.length > 0
    ? __BUILD_STAMP__
    : 'dev';
}