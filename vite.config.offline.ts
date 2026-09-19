/**
 * 离线单文件构建配置（vite.config.offline.ts）。
 *
 * 用途：产出「双击即开」的离线包。
 *
 * 为什么需要单独一份配置：
 *   常规 `vite build` 产出 `index.html` + `assets/*.js`，其中入口是
 *   `<script type="module">`。浏览器在 `file://` 协议下会把模块脚本当作
 *   跨源请求处理（origin 为 `null`），因缺少 CORS 响应头而被拦截，表现为
 *   白屏。`base: './'` 只解决「路径解析」，解决不了「模块跨源拦截」。
 *   因此离线包必须把 JS/CSS 全部内联进 index.html，消除外部资源请求。
 *
 * 产出：`dist/index.html`（单文件，无外部依赖，**双击即可运行**）。
 *
 * 使用：`npm run build`
 *
 * 注意：本形态可双击运行，但 `file://` 下 **IndexedDB 会被 Chrome 阻止**，
 * 项目库持久化能力受限。需要完整持久化请改用 `npm run build:server`
 * 并通过本地 HTTP 访问。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // 将全部 JS/CSS 内联进 index.html，使产物不再有外部资源请求。
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // 单文件产物体积较大，关闭内联资源大小限制。
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    chunkSizeWarningLimit: 10_000,
  },
});
