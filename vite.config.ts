import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * HTTP 服务版构建配置（多文件、支持 code-split）。
 *
 * 产物：`dist-server/`
 * 用途：通过 HTTP 提供服务时使用（`npm run build:server` + `npm run preview`）。
 *       此形态下 **IndexedDB 可用**，项目库可正常持久化。
 *
 * ⚠️ 本产物**不能双击打开**：入口是 `<script type="module">`，
 *    在 `file://` 下会被 CORS 拦截。离线双击请用 `npm run build`
 *    （见 `vite.config.offline.ts`）。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-server',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
