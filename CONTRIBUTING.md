# 贡献指南（CONTRIBUTING）

感谢你有兴趣改进 Hogo-QA-tool。这是一个**面向工厂质量人员**的离线质量管理工具，
所以这个仓库对「正确性」的要求高于一般前端项目：统计口径算错，用户可能据此停线或放行。

## 开发环境

```bash
node -v            # 需要 >= 22.22.2（本仓库在 Node 24 LTS 上开发）
npm ci             # 按 lock 文件安装
npm run dev        # 开发服务器
```

## 提交前必须跑的四个门禁

```bash
npm run typecheck   # tsc -p tsconfig.app.json --noEmit（**不要**直接跑 tsc --noEmit，见下）
npm run lint        # eslint
npm test            # vitest run
npm run build       # 离线单文件产物（dist/index.html）
```

`tsconfig.json` 是 solution-style（`files: []` + `references`），对它跑 `tsc --noEmit`
会**检查 0 个文件并退出 0** —— 那是空洞门禁，务必用 `npm run typecheck`。

## 代码约定

- **分层**：`core`（纯计算，无 React / 无 DOM）→ `data`（导入导出 / 持久化）→
  `services`（AI、报表编排）→ `store`（zustand）→ `ui`。跨层反向依赖一律不允许。
- **统计口径写清楚**：涉及 Cp/Cpk/Pp/Ppk、控制限、判异准则的改动，必须说明用的是哪种 σ 口径
  （组内 R̄/d2 还是整体 ddof=1），并补一条**对基准数据**的断言。
- **注释写「为什么」**：本项目源码注释以中文为主，倾向记录取舍理由与实测依据，
  而不是复述实现步骤。改动带测量/踩坑结论时请一并写进注释。
- **禁止动态 `import()`**：离线单文件产物要求页面以非模块脚本运行，
  动态导入会注入基于 `import.meta.url` 的 helper 并在 `file://` 下抛 `SyntaxError`。
- **不要提交**：密钥、`.secrets/`、`.workbuddy/`（内部笔记）、`.probe/` 下的结果 JSON/TXT、
  本机绝对路径。CI 与 review 都会检查这一点。

## 测试与验证

- 新增行为**必须**有用例；只加实现不加测试的 PR 会被要求补。
- 修复统计学缺陷时，推荐同时补一条「变异测试」记录（把修复点改坏 → 用例必须变红），
  说明这条用例不是摆设。仓库里的历史提交大量采用这个做法。
- **真实基准数据**：需要真实 xlsx 的用例默认读仓库内 fixture
  （`src/data/__tests__/fixtures/quality_data.xlsx`，150 行 dimension + 6 行 defect）。
  想换成自己的文件：`HOGO_REAL_XLSX=/path/to/quality_data.xlsx npm test`；
  两者都没有时这几组用例会**整体 skip**（不会红），以保护新克隆与 CI。
- 真机验收脚本在 `.probe/`，见 `.probe/README.md`（多数脚本写死了作者本机的 Chrome 路径与端口）。

## 提交信息

采用 `type(scope): 摘要` 形式，摘要与正文用中文（与本仓库历史一致）：

```
fix(ai): 断流不再只有一句「响应流中断」

- 一行为动机
- 一行为改动
- 一行为验证（跑了什么、结果如何）
```

`type` 取 `feat` / `fix` / `test` / `docs` / `chore` / `refactor` / `perf`。

## 分支与 PR

1. 从 `main` 切分支：`feat/xxx`、`fix/xxx`。
2. 提交前跑完上面四个门禁，PR 描述里贴出实际输出（或说明为何无法运行）。
3. PR 模板里有一份自查清单，勾完再请求 review。

## 许可证

提交即表示你同意以本仓库的 [MIT 许可证](./LICENSE) 授权你的贡献。