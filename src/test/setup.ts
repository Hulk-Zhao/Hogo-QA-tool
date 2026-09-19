/**
 * vitest 全局测试设置。
 *
 * 设计要点：
 * - **按环境惰性加载**：jest-dom 断言扩展（`toBeInTheDocument` 等）与
 *   testing-library 的 DOM cleanup 只在浏览器环境（jsdom）下动态 import，
 *   因此 `src/core/**` 的 node 环境测试**完全不依赖**这两个包。
 * - 在 jsdom 环境下补一个 matchMedia 空实现，避免 MUI 响应式组件报错。
 * - 运行环境由 vitest 决定：默认 node；组件测试文件顶部用
 *   `// @vitest-environment jsdom` 切换。
 */

import { afterEach } from 'vitest';

/** 判定当前是否为 DOM（浏览器/jsdom）环境。 */
const isDomEnvironment = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isDomEnvironment) {
  // MUI 响应式组件依赖 matchMedia；jsdom 未实现，此处补空实现。
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }

  // 仅 DOM 环境加载 jest-dom 扩展（顶层 await 保证断言注册先于用例执行）。
  await import('@testing-library/jest-dom/vitest');

  // 每个用例后清理 testing-library 挂载的 DOM。
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  });
}
