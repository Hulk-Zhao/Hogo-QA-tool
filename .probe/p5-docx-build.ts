/** 生成真实 .docx 产物（供 python-docx 验收）。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildAiReportDocx, aiReportDocxFileName } from '@/services/report/docxReport';
import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';

const model = {
  projectName: '外壳长度项目',
  generatedAt: '2026-09-19T08:00:00.000Z',
  cpkSummary: [],
  defectStats: [],
  rawDimensions: [],
  rawDefects: [],
  warnings: [],
};

const analyses = [
  {
    moduleId: 'cpk', title: 'CPK 汇总', ok: true, model: 'deepseek-chat',
    errorMessage: null, skipReason: null, sentFields: [],
    markdown: [
      '## 总体结论', '',
      '过程能力总体充足，**外壳长度 Cpk=3.65** 高于 1.33 的合格线。', '',
      '### 关键统计量', '',
      '- 外壳长度：Cpk=3.65 / Ppk=3.14（均值 50.05，σ组内 0.05）',
      '- 转轴直径：Cpk=2.15 / Ppk=1.55，接近但未达优秀线', '',
      '| 特性 | Cpk | Ppk |', '| --- | --- | --- |',
      '| 外壳长度 | 3.65 | 3.14 |', '| 转轴直径 | 2.15 | 1.55 |', '',
      '### 改善建议', '',
      '1. 优先关注转轴直径的 Ppk（1.55 < 1.67）',
      '2. 复核量具与抽样方案', '',
      '> 口径：Cpk / Ppk ≥ 1.33 为合格，≥ 1.67 为优秀（本工具口径）。',
    ].join('\n'),
  },
  {
    moduleId: 'defect', title: '不良统计 & 特殊字符 <测试>', ok: true, model: 'deepseek-chat',
    errorMessage: null, skipReason: null, sentFields: [], markdown: '- 划伤 12 件，占 60%',
  },
  {
    moduleId: 'pareto', title: '柏拉图（80% 分界线）', ok: false, model: '',
    errorMessage: null, skipReason: '本次未导入不良记录，无法生成柏拉图。', sentFields: [],
  },
] as unknown as ModuleAnalysis[];

const buf = buildAiReportDocx(model as never, analyses, {
  model: 'deepseek-chat',
  focusIds: ['capability', 'riskWarning'],
  generatedAt: '2026-09-19T09:30:00.000Z',
});
mkdirSync('.probe/out', { recursive: true });
const out = `.probe/out/${aiReportDocxFileName(model as never)}`;
writeFileSync(out, Buffer.from(buf));
console.log(JSON.stringify({ out, bytes: buf.byteLength }));