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

> **产物自证版本**：两个构建配置都会在打包时注入构建时间戳，
> 在「设置 → 数据与隐私说明」底部显示为 `构建：2026-09-19 11:24`（本地时区）。
> 排障时**先看这一行**：看不到它 = 你打开的是本特性之前的旧产物（已两次导致误报「打印没有图表」）。

### ⭐ 怎么运行最省事

**双击 `start.bat`** —— 自动构建（首次）、启动本地服务、并打开浏览器。
这是**功能最完整**的方式（IndexedDB 可用，项目库能正常保存）。

### 双击 `dist/index.html`（纯离线，无需 Node）

`npm run build` 产出的 `dist/index.html` 把 JS/CSS 全部内联，双击即可打开，
不需要任何服务器或 Node 环境。**适合拷给同事、放 U 盘、装机即用。**

> ⚠️ **看不到图表 / 像是旧界面？先确认不是旧产物。**
> 浏览器会缓存、桌面也可能留着上一次构建的文件。若「设置」页底部看不到
> `构建：…` 一行，说明你打开的是旧产物；重新执行 `npm run build` 并**关闭旧标签页**
> （必要时 Ctrl+F5 硬刷新）后再看。

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
>
> ⚠️ **离线包是「快照」，改完代码必须重新构建**：`dist/index.html` 是 `npm run build` 那一刻的完整副本，
> 不会自动跟随源码更新。**如果你双击的是几天前生成的 `dist/index.html`，看到的仍是旧功能**
> （例如报表页没有图表）。升级代码后请重新执行 `npm run build`，并关闭旧标签页重新打开。
> 判断是不是最新版：打开「报表导出」页，若**有**「导出范围（勾选状态自动保存，刷新后保持）」这一栏、且下方有「图表」区域，就是新版；
> 若只看到「报表数据规模 / CPK 汇总预览 / 不良统计预览」三块，说明你打开的是旧快照。

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

**4）提示「请求内容被服务端拒绝，请检查模型名与参数。（HTTP 400）」**

该提示的括号里现在会带上**服务端返回的原文**（气泡下方另有独立的一行「服务端原文」），
例如 `（HTTP 400：model is required）`。请以服务端原文为准排查，常见两种：

- `model is required`：**「设置」页的「模型名」是空的**。本工具已在探测阶段就拦住这种情况
  （模型名为空时直接判定离线模式并在「设置」页说明），不会再发出必然 400 的请求。
- `model 'xxx' not found`：模型名写错或本机没拉取该模型。用 `ollama list` 核对名称后按原样填写
  （含标签，如 `qwen3.5:9b`）。

> 设计口径：HTTP 非 2xx 时，工具会把服务端响应体里的原因**折叠成一行并截断到 300 字**后展示，
> 而不是只给一句「请检查模型名与参数」——后者无法自助定位。

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
| 判异准则 | ✅ | Western Electric W1–W4 + Nelson N1–N8，逐条开关（刷新后保持）、去重与等效标注 |
| 报表导出 | ✅ | 导出范围 7 项逐项勾选（4 张表 + 3 张图，勾选状态刷新后保持）、图表内嵌打印、Excel ≥4 sheet（不含图片） |
| AI 助手 | ✅ | OpenAI 兼容 API、三态探测、数据主权边界（默认仅发摘要）、AI 全面诊断（五节结构，可导出 Markdown） |
| 设置 | ✅ | AI 配置与连通性测试、**一键清除已保存配置**、判异准则逐条开关、常数表展示（n=2..25）、AI 调用审计（**跨会话保留**） |
| 项目库 | ✅ | 搜索 / 打开 / 重命名 / 复制 / 删除（IndexedDB，降级 localStorage / 内存）；**刷新 / 重开后自动恢复上次项目** |

## 安全与风险边界

本工具默认离线、数据不出本机，但仍有三处**已知边界**需要用户知情：

### 1. API Key 以明文存于本机浏览器（localStorage）

`file://` 双击离线形态下没有可用的加密后端，密钥只能以明文写入
`localStorage["hogo-qa-settings"]`（设置页已在 API Key 下方明示）。风险与对策：

- 影响面：仅本机浏览器配置目录；本工具**不会**把密钥发往任何非用户配置的地址。
- **一键擦除**：「设置」页 → 「清除已保存的 AI 配置」，会删除整个
  `hogo-qa-settings` 键（不是把字段写空），并同步复位内存中的配置。
- 建议：公用/共享电脑上用完后点一次该按钮；不要在多人共用的浏览器配置里长期保存生产密钥。

### 2. xlsx@0.18.5 的原型污染风险（CVE-2023-30533）

导入旧工具 xlsx 依赖 SheetJS `0.18.5`——npm registry 上可安装的最后一个版本
（0.19.3+ 只发布在 SheetJS 自有 CDN）。因此导入器在**出口**做了独立于版本的防护：

- 解析前后对比 `Object.prototype`，删除被注入的属性，并在导入结果里给出
  「该文件尝试污染全局对象原型（已拦截并清理：…）」告警；
- 单元格出口白名单：只放行 `string | number | null`，对象 / 数组 / 函数一律当空值。

中期动作：评估迁移到 `exceljs`（见 `.workbuddy/memory/2026-09-19-P0优化记录.md` 第九节风险项）。

### 3. 本机存储键清单（便于审计与手工清理）

| localStorage 键 | 内容 |
|---|---|
| `hogo-qa-settings` | AI 配置（含明文 API Key） |
| `hogo-qa-preferences` | 判异准则 12 条开关 + 报表导出范围 7 项 |
| `hogo-qa-diagnosis` | AI 全面诊断报告（最新一份） |
| `hogo-qa-ai-usage-logs` | AI 调用审计记录（最多 500 条，只增不减） |
| `hogo-qa-last-project` | 上次保存 / 打开的项目 id（启动自动恢复用） |

项目实体与测量值不在上述键中：走 IndexedDB（`projects` / `measurements`），
IndexedDB 不可用时降级 localStorage，再不可用则仅内存（UI 会提示导出 JSON）。

## 数据主权

AI 功能默认**只发送统计摘要，绝不包含逐条原始测量值**。
sendRawData 需用户显式勾选并二次确认，且每次请求的 scope 记入 `AiUsageLog`。
payload 构造采用**白名单拷贝**，新增字段默认不外发。

## 文档

- `docs/00-范围决策与调研结论.md` —— 范围决策、旧工具缺陷、行业调研
- `docs/01-基准数据与验证口径.md` —— 回归基准值与验收口径
- `docs/PRD_v1.0.md` —— 产品需求文档
- `docs/system_design.md` —— 系统架构设计（含统计公式与判异算法定义）
