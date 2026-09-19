# Hogo-QA-tool

离线质量过程能力分析工具 —— **SPC / CPK / 柏拉图 / 判异准则**。

面向工厂质量人员，替代原有的 Python 桌面工具（`E:\tools\品质工具`），
提供 Web UI、双模式（离线 / AI）、可审计的项目化管理。

## 核心差异化

原工具存在一处统计学缺陷：`spc.py` 中 `std_sub = std_total`，**未做子组分组**，
导致 **Pp 恒等于 Cp** —— 组内变异与整体变异无法区分，能力指数不可信。

本工具修正该问题，采用**双西格玛口径**：

| 指数 | σ 口径 | 含义 |
|------|--------|------|
| Cp / Cpk | σ_within（组内：R̄/d2 或 S̄/c4） | 过程**潜在**能力 |
| Pp / Ppk | σ_overall（整体，ddof=1） | 过程**实际**表现 |

同时展示**双西格玛水平**（短期 3×Cpk vs 工程口径 3×Cpk+1.5）并标注差异，
避免两者混用造成误判。

## 技术栈

Vite 5 · React 18 · TypeScript 5 · MUI 5 · Tailwind 3 · zustand 4 ·
ECharts 5 · SheetJS 0.18 · idb 8 · vitest 2 · dayjs

**无后端**，静态站点可完全离线运行。

## 架构分层

```
core（纯函数内核）→ data（导入/导出/持久化）→ services（业务编排）→ ui / store
```

`src/core/**` 通过 ESLint `no-restricted-imports` **强制零 React / DOM 依赖**，
保证统计公式可在 node 环境被独立验证 —— 这是整个项目可验证性的基石。

## 快速开始

```bash
npm install         # 首次
npm run dev         # 开发模式 → http://localhost:5173/
npm test            # 运行全部测试
npm run typecheck   # 类型检查
npm run lint        # 代码检查
```

### 构建

| 命令 | 产物 | 用途 |
|------|------|------|
| `npm run build` | `dist/index.html` | **单文件离线版**，双击即可运行 |
| `npm run build:server` | `dist-server/` | HTTP 服务版（支持 code-split） |
| `npm run preview` | — | 预览 `dist-server/` |
| `npm run serve` | — | 零依赖本地服务器（默认 8787 端口） |

### ⭐ 怎么运行最省事

**双击 `start.bat`** —— 自动构建（首次）、启动本地服务、并打开浏览器。
这是**功能最完整**的方式（IndexedDB 可用，项目库能正常保存）。

### 双击 `dist/index.html`（纯离线，无需 Node）

`npm run build` 产出的 `dist/index.html` 把 JS/CSS 全部内联，双击即可打开，
不需要任何服务器或 Node 环境。**适合拷给同事、放 U 盘、装机即用。**

> ⚠️ **两种方式的能力差异（实测）**
>
> | 能力 | 双击 `dist/index.html` | `start.bat` / HTTP |
> |------|----------------------|-------------------|
> | 数据导入 / CPK / 控制图 / 柏拉图 / 报表 | ✅ | ✅ |
> | AI 解读（需联网 + Key） | ✅ | ✅ |
> | **项目库持久化保存** | ⚠️ 受限 | ✅ |
>
> 原因：Chrome 在 `file://` 协议下**阻止 IndexedDB**（`indexedDB` 对象存在，
> 但 `open()` 会超时失败）。`localStorage` 在 `file://` 下正常。
> 因此**需要长期保存项目时，请用 `start.bat`**。

### 为什么不能用 `dist-server/index.html` 双击

它的入口是 `<script type="module" src="./assets/index.js">`。
浏览器在 `file://` 下会把模块脚本当作跨源请求处理（origin 为 `null`），
因缺少 CORS 响应头而被拦截 → **白屏**。
`base: './'` 只解决路径解析，**解决不了模块的跨源拦截**。

### 路由：为什么按协议切换

`file://` 下页面 origin 为 `null`，`BrowserRouter` 内部调用
`history.replaceState` 会抛：

```
Failed to execute 'replaceState' on 'History':
A history state object with URL 'file:///E:/import' cannot be created
in a document with origin 'null'
```

因此 `src/main.tsx` 按协议自动选择：`file://` → `HashRouter`，http(s) → `BrowserRouter`。

### 为什么必须消除动态 `import()`

`vite-plugin-singlefile` 只有在产物**不含动态 `import()`** 时才能产出纯内联脚本。
一旦存在动态导入，Vite 会注入基于 `import.meta.url` 的预加载 helper，
而 `import.meta` 在**非模块脚本**中会直接抛 `SyntaxError`，离线包白屏。
因此源码中**禁止使用动态 `import()`**。

### 类型检查门禁（重要）

`tsconfig.json` 是 solution-style 配置（`"files": []` + `references`），
对它执行 `tsc --noEmit` 会**检查 0 个文件并退出 0** —— 是空洞门禁。
必须用：

```bash
npm run typecheck   # = tsc -p tsconfig.app.json --noEmit
```

排查方法：`npx tsc --noEmit --listFilesOnly | wc -l`，若为 0 说明配置没指向任何文件。

### AI 助手返回空 / 连不上本机模型怎么办

AI 模式对接本机 Ollama / LM Studio 等 OpenAI 兼容服务。以下三类问题最常见，可自助排查。

**1）返回内容为空**

本机 Ollama 的**推理模型**（`qwen3.5`、`deepseek-r1` 等）会先生成长篇「思考」，
而思考过程与正文**共享同一份输出配额**：配额被思考吃光时，正文即为空
（服务端返回 `finish_reason: length`，`content` 为 0 字符）。本工具**默认已开启
「关闭模型思考」**（请求带 `reasoning_effort: none`），请到「设置」页确认该开关为开启。

> ⚠️ 若你手动关掉了「关闭模型思考」，请到同页调大「最大输出 tokens」。
> 但要注意：**推理模型的思考长度不可预测**。实测 `qwen3.5:9b` 在本工具的摘要任务上，
> 即使把上下文放宽到 16384、配额给到 4096，思考过程仍会耗尽全部配额、`content` 依旧是空的。
> 因此**除非确有必要，建议保持「关闭模型思考」为开启状态**（本工具默认即开启）。

**2）双击版连不上本机 Ollama**

`file://` 打开时页面 origin 为 `null`，而 Ollama 默认对 `Origin: null`
返回 **403 且不带 CORS 响应头**，浏览器跨源策略因此拦截请求。二选一解决：
设环境变量 `OLLAMA_ORIGINS=*` 后重启 Ollama；或改用 `start.bat` 通过本地服务打开。

**3）提示上下文不足 / 请求被截断**

Ollama 默认上下文窗口 `num_ctx = 4096`，而本工具发送的统计摘要 JSON 本身已约
**2,100 tokens**，余量偏薄。设 `OLLAMA_CONTEXT_LENGTH=16384` 放宽。

**一键启动命令（Windows `cmd`，可直接复制）**

```
set OLLAMA_ORIGINS=* && set OLLAMA_CONTEXT_LENGTH=16384 && ollama serve
```

改环境变量后需**重启 Ollama** 才生效；随后到「设置」页点「连通性测试」确认已进入 AI 模式。

## 功能模块

| 模块 | 状态 | 说明 |
|------|------|------|
| 数据导入 | ✅ | 旧工具 xlsx 双 sheet 兼容、CSV 长/宽表、粘贴导入；20 万条上限提示 |
| 能力分析 | ✅ | Cp/Cpk/Pp/Ppk 双口径、双西格玛水平、正态性检验、异常值两步确认 |
| 柏拉图 | ✅ | 双 Y 轴、80% 分界线、悬浮显示频数与累计占比 |
| 控制图 | ✅ | 7 种图（Xbar-R/S、I-MR、P、NP、C、U）、分区带、违规高亮、变限 P/U |
| 判异准则 | ✅ | Western Electric W1–W4 + Nelson N1–N8，逐条开关、去重与等效标注 |
| 报表导出 | ✅ | Excel ≥4 sheet（不含图片）、浏览器打印 PDF |
| AI 助手 | 🚧 | OpenAI 兼容 API、三态探测、数据主权边界（默认仅发摘要） |
| 设置 | 🚧 | AI 配置、常数表展示（n=2..25） |
| 项目库 | 🚧 | 搜索 / 重命名 / 删除 / 复制 |

## 数据主权

AI 功能默认**只发送统计摘要，绝不包含逐条原始测量值**。
sendRawData 需用户显式勾选并二次确认，且每次请求的 scope 记入 `AiUsageLog`。
payload 构造采用**白名单拷贝**，新增字段默认不外发。

## 文档

- `docs/00-范围决策与调研结论.md` —— 范围决策、旧工具缺陷、行业调研
- `docs/01-基准数据与验证口径.md` —— 回归基准值与验收口径
- `docs/PRD_v1.0.md` —— 产品需求文档
- `docs/system_design.md` —— 系统架构设计（含统计公式与判异算法定义）
