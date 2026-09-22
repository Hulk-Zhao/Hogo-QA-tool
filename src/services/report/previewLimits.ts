/**
 * previewLimits —— 报表预览表的行数上限（屏幕 / 打印两套口径）。
 *
 * 为什么独立成文件：`src/print.css` 用 `nth-child(n + N)` 实现**打印态**行数上限，
 * 与这里的 `PRINT_PREVIEW_LIMIT` 是一对必须同时改的常量。放在 services 层
 * （不依赖 React / MUI / DOM）才能让用例把 CSS 文本与常量对起来验证，
 * 见 `__tests__/previewLimits.spec.ts` —— 「成对出现、缺一不可」这条要求因此可证伪。
 */

/**
 * 原始明细表在**屏幕**上的最大渲染行数。
 *
 * 理由：`DataTable` 未做虚拟滚动，而原始尺寸在 20 万行上限下逐行渲染会直接
 * 冻结浏览器（连打印对话框都弹不出来）。日报的用途是汇总，故预览取前 200 行
 * 并在表头明确标注「仅显示前 N 行，完整数据请导出 Excel」，避免误导。
 */
export const RAW_PREVIEW_LIMIT = 200;

/**
 * 预览表在**纸上**最多印多少行（约一张 A4 可打印高度）。
 *
 * 两端的坏结果（都实测过）：
 *  - 照屏幕的 200 行全印：120 行原始尺寸 ≈ 4 页纯数据，整本 4 页 → 8 页（分页爆炸）；
 *  - 按屏幕的「限高 320px 滚动框」原样打印：纸上只有 8 行，且**没有任何提示**
 *    —— 用户无从知道还有 112 行没印（静默丢数据）。
 *
 * 取 24 行的依据（实测 .probe/p6-print-pages.mjs 的产物，该 JSON 不入库）：
 *  - 24 行 + 卡片标题 ≈ 一页，允许跨页后能把前一页的空档填满
 *    （第 3 页利用率 68.7% → 96.0%，整本仍是 4 页）；
 *  - 同时 ReportPage 在纸上显式写明「打印仅含前 24 行，完整数据请用导出 Excel」。
 *
 * ⚠️ 改这个值必须同步改 `src/print.css`：
 *    `.print-table-split tbody tr:nth-child(n + PRINT_PREVIEW_LIMIT + 1)`
 */
export const PRINT_PREVIEW_LIMIT = 24;