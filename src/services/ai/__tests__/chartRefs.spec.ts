/**
 * chartRefs 测试（P8）。
 *
 * 用户指令：「同时可以引用或者生成图表来参考解释」。
 * 口径：模型只能引用图表目录里的 id，前端用真实数据渲染；标记不进正文。
 */

import { describe, expect, it } from 'vitest';
import { extractChartRefIds, stripChartRefs } from '@/services/ai/chartRefs';

describe('extractChartRefIds', () => {
  it('抽出合法 id 并去重、保序', () => {
    const text = '结论如下。\n[[chart:control:外壳长度]]\n再看分布：\n[[chart:histogram:外壳长度]]\n回看控制图 [[chart:control:外壳长度]]';
    expect(extractChartRefIds(text)).toEqual(['chart:control:外壳长度', 'chart:histogram:外壳长度']);
  });

  it('容忍空格写法与特性名里的冒号', () => {
    expect(extractChartRefIds('[[ chart : control : 轴:1 ]]')).toEqual(['chart:control:轴:1']);
  });

  it('非法 id（模型自造）一律丢弃 —— 不许画不存在的图', () => {
    expect(extractChartRefIds('[[chart:bogus:x]] [[chart:control]] [[随便]]')).toEqual([]);
  });

  it('没有标记时返回空数组', () => {
    expect(extractChartRefIds('过程受控，无判异点。')).toEqual([]);
  });
});

describe('stripChartRefs', () => {
  it('去掉标记并清理多余空行（气泡里不留突兀空档）', () => {
    const text = '第一段结论。\n[[chart:control:外壳长度]]\n\n第二段结论。';
    expect(stripChartRefs(text)).toBe('第一段结论。\n\n第二段结论。');
  });

  it('没有标记时只做首尾去白（正文不变）', () => {
    expect(stripChartRefs('  过程受控。  ')).toBe('过程受控。');
  });

  it('幂等：去掉标记后再处理一次结果不变', () => {
    const once = stripChartRefs('A\n[[chart:pareto:all]]\nB');
    expect(stripChartRefs(once)).toBe(once);
  });
});