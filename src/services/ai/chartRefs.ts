/**
 * chartRefs —— AI 回复里的「图表引用」标记（P8）。
 *
 * 用户指令：「同时可以引用或者生成图表来参考解释」。
 *
 * 口径（刻意如此）：**不新增图表对象、也不许模型编造数据**。
 * 模型只能在正文里引用 `analysisContext.chartCatalogue` 给出的 id，
 * 由前端用**项目里真实存在的数据**渲染那张图 —— 这样「图」与「数」永远一致，
 * 也不可能把模型幻觉出来的曲线画给用户看。
 *
 * 标记格式（单独成行、逐字来自图表目录）：
 *   [[chart:control:转轴直径]]
 *   [[chart:histogram:外壳长度]]
 *   [[chart:pareto:all]]
 *
 * 出处：用户指令「修改问答的逻辑…同时可以引用或者生成图表来参考解释」。
 */

import { parseChartRefId } from './analysisContext';

/** 图表引用标记（每次调用返回新实例，避免 /g 正则的 lastIndex 状态泄漏）。 */
export function chartRefPattern(): RegExp {
  return /\[\[\s*chart\s*:\s*([^\]\n]+?)\s*\]\]/g;
}

/**
 * 抽出回复里引用到的图表 id（去重、保序、丢弃非法 id）。
 *
 * @param text 模型回复原文
 * @returns 合法且去重的图表 id 列表
 */
export function extractChartRefIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(chartRefPattern())) {
    // 捕获到的是「冒号后面的部分」，这里补回前缀再解析 —— 顺便把
    // `[[ chart : control : 轴:1 ]]` 这类多空格写法归一化成标准 id。
    const parsed = parseChartRefId(`chart:${(match[1] ?? '').trim()}`);
    if (parsed === null) {
      continue;
    }
    const id = `chart:${parsed.kind}:${parsed.characteristic}`;
    if (!out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * 去掉正文里的引用标记（标记是给程序看的，不该出现在气泡里）。
 *
 * 顺带清理标记那一行留下的空白与多余空行，避免气泡里出现突兀的空档。
 *
 * @param text 模型回复原文
 * @returns 面向用户展示 / 复制的正文
 */
export function stripChartRefs(text: string): string {
  return text
    .replace(chartRefPattern(), '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}