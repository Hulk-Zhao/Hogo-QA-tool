import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * vitest 配置。
 *
 * 默认 environment = node（保证 `src/core/**` 纯函数测试零 DOM 依赖）；
 * 组件测试文件顶部用 `// @vitest-environment jsdom` 单独切换。
 *
 * setupFiles 指向 `src/test/setup.ts`，该文件按环境惰性加载
 * jest-dom / testing-library，因此 node 环境测试完全不依赖它们。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
