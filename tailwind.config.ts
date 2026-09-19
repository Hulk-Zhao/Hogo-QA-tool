import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置。
 *
 * 注意：MUI 为主组件库，Tailwind 仅作工具类补充。
 * `preflight` 关闭以避免与 MUI 的 CSSBaseline 冲突。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
