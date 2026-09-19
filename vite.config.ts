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
