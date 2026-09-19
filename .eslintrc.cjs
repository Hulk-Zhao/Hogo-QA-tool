/**
 * ESLint 配置（架构 §0.2 分层边界强制）。
 *
 * 核心约束：`src/core/**` 必须是**纯函数内核**，禁止依赖 React / DOM / 浏览器 API，
 * 否则 QA 无法在 node 环境独立验证统计公式（这是整个项目可验证性的基石）。
 *
 * 分层（严格单向依赖）：
 *   core（纯函数） → data → services → store/ui
 */

module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['dist', 'node_modules', '*.cjs', '*.config.ts', 'coverage'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  overrides: [
    {
      /*
       * 【最关键】core 层纯度边界：禁止 React / MUI / DOM / 浏览器 API。
       * 违反即破坏 QA 独立验证能力，因此设为 error。
       */
      files: ['src/core/**/*.ts'],
      excludedFiles: ['**/__tests__/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'react', message: 'core 层必须是纯函数内核，禁止依赖 React。' },
              { name: 'react-dom', message: 'core 层禁止依赖 react-dom。' },
              { name: 'react-router-dom', message: 'core 层禁止依赖路由。' },
              { name: 'zustand', message: 'core 层禁止依赖状态库。' },
              { name: 'echarts', message: 'core 层禁止依赖图表库。' },
              { name: 'echarts-for-react', message: 'core 层禁止依赖图表库。' },
              { name: 'idb', message: 'core 层禁止依赖存储库。' },
              { name: 'xlsx', message: 'core 层禁止依赖 xlsx 解析库。' },
            ],
            patterns: [
              { group: ['@mui/*'], message: 'core 层禁止依赖 MUI。' },
              { group: ['@/data/*', '@/services/*', '@/store/*', '@/ui/*'], message: 'core 层不得反向依赖上层。' },
            ],
          },
        ],
        // 禁止 DOM / 浏览器全局，防止 core 偷偷依赖运行环境。
        'no-restricted-globals': [
          'error',
          { name: 'window', message: 'core 层禁止使用 window。' },
          { name: 'document', message: 'core 层禁止使用 document。' },
          { name: 'localStorage', message: 'core 层禁止使用 localStorage。' },
          { name: 'sessionStorage', message: 'core 层禁止使用 sessionStorage。' },
          { name: 'fetch', message: 'core 层禁止发起网络请求。' },
          { name: 'navigator', message: 'core 层禁止使用 navigator。' },
        ],
      },
    },
    {
      /* data 层：禁止 UI / 状态 / 路由；存储访问只允许走 storage 适配器。 */
      files: ['src/data/**/*.ts'],
      excludedFiles: ['**/__tests__/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'react', message: 'data 层禁止依赖 React。' },
              { name: 'react-dom', message: 'data 层禁止依赖 react-dom。' },
              { name: 'react-router-dom', message: 'data 层禁止依赖路由。' },
              { name: 'zustand', message: 'data 层禁止依赖状态库。' },
              { name: 'echarts', message: 'data 层禁止依赖图表库。' },
            ],
            patterns: [
              { group: ['@mui/*'], message: 'data 层禁止依赖 MUI。' },
              { group: ['@/services/*', '@/store/*', '@/ui/*'], message: 'data 层不得反向依赖上层。' },
            ],
          },
        ],
        'no-restricted-globals': [
          'error',
          { name: 'localStorage', message: 'data 层存储访问须经 storage 适配器注入。' },
          { name: 'sessionStorage', message: 'data 层存储访问须经 storage 适配器注入。' },
          { name: 'fetch', message: 'data 层禁止发起网络请求。' },
        ],
      },
    },
    {
      /* services 层：禁止 React / UI；只能依赖 core 与 data。 */
      files: ['src/services/**/*.ts'],
      excludedFiles: ['**/__tests__/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'react', message: 'services 层禁止依赖 React。' },
              { name: 'react-dom', message: 'services 层禁止依赖 react-dom。' },
            ],
            patterns: [
              { group: ['@mui/*'], message: 'services 层禁止依赖 MUI。' },
              { group: ['@/ui/*', '@/store/*'], message: 'services 层不得反向依赖 UI/store。' },
            ],
          },
        ],
      },
    },
    {
      /* 测试文件：放宽限制，允许直接访问 DOM 与断言库。 */
      files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
      rules: {
        'no-restricted-imports': 'off',
        'no-restricted-globals': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
