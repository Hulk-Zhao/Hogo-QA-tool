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

/**
 * 构建时间戳（**本地时区**，形如 `2026-09-19 11:20`）。
 *
 * 刻意用本地时区而非 `toISOString()`（UTC）：用户是拿它跟资源管理器里的
 * 文件修改时间比对的，差 8 小时会让判断「我打开的是不是新产物」直接失效。
 * 两份构建配置各自独立，这里接受少量重复。
 */
function localStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

export default defineConfig({
  base: './',
  // 构建标识注入（见 src/ui/buildStamp.ts）：让产物能自证「我是哪一版」，
  // 避免再次出现「用户打开的是修复前旧离线包」这类只能靠比对时间戳排障的问题。
  define: {
    __BUILD_STAMP__: JSON.stringify(localStamp()),
  },
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
