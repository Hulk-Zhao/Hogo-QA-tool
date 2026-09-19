/**
 * markdownReport —— 结构化 Markdown 报告生成（P1-01；T05 验收要点 5）。
 *
 * 由报表中间模型（`@/data/exporter/reportModel`）构造可直接复制的
 * Markdown 文本，含「摘要 / 结论 / 建议」三节与图数据表。
 *
 * 纯函数：不含 DOM / 网络依赖，可 Node 裸跑。
 */

import { capabilityVerdictText } from '../../core/stats/capabilityVerdict';
import type { CpKSummaryRow, DefectStatRow, ReportModel } from '../../data/exporter/reportModel';

/** 指数格式化：null → 「—」，数字 → 保留 3 位小数（去尾零）。 */
export function fmtIndex(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return String(Number(value.toFixed(3)));
}

/** 数值格式化：null → 「—」，否则按指定小数位。 */
export function fmtNumber(value: number | null, decimals = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(decimals);
}

/**
 * 能力门槛判定文案。
 *
 * 口径唯一真源在 `core/stats/capabilityVerdict`（本轮抽出，供 Markdown 报告与
 * P1-03 批量对比表共用），此处仅做字段取值适配。
 */
function capabilityVerdict(row: CpKSummaryRow): string {
  return capabilityVerdictText(row.cpk);
}

/**
 * 构造 CPK 汇总 Markdown 表。
 *
 * @param rows CPK 汇总行
 * @returns Markdown 表格文本
 */
export function buildCpkTable(rows: CpKSummaryRow[]): string {
  if (rows.length === 0) {
    return '_无有效测量数据，CPK 汇总为空。_\n';
  }
  const header =
    '| 特性 | n | 均值 | σ组内 | σ整体 | USL | LSL | Ca | Cp | Cpk | Pp | Ppk | 判定 |\n' +
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.characteristic} | ${r.n} | ${fmtNumber(r.mean, 4)} | ${fmtNumber(r.sigmaWithin, 4)} | ` +
        `${fmtNumber(r.sigmaOverall, 4)} | ${fmtNumber(r.usl, 4)} | ${fmtNumber(r.lsl, 4)} | ` +
        `${fmtIndex(r.ca)} | ${fmtIndex(r.cp)} | ${fmtIndex(r.cpk)} | ${fmtIndex(r.pp)} | ` +
        `${fmtIndex(r.ppk)} | ${capabilityVerdict(r)} |`,
    )
    .join('\n');
  return `${header}\n${body}\n`;
}

/**
 * 构造不良统计 Markdown 表（柏拉图口径）。
 *
 * @param rows 不良统计行
 * @returns Markdown 表格文本
 */
export function buildDefectTable(rows: DefectStatRow[]): string {
  if (rows.length === 0) {
    return '_无不良记录数据。_\n';
  }
  const header = '| 不良类型 | 数量 | 占比(%) | 累计占比(%) |\n|---|---:|---:|---:|';
  const body = rows
    .map((r) => `| ${r.defectType} | ${r.count} | ${fmtNumber(r.ratio, 2)} | ${fmtNumber(r.cumRatio, 2)} |`)
    .join('\n');
  return `${header}\n${body}\n`;
}

/**
 * 生成「结论」小节文字。
 *
 * @param model 报表模型
 * @returns 结论文本（多条要点）
 */
export function buildConclusions(model: ReportModel): string {
  const lines: string[] = [];
  const valid = model.cpkSummary.filter((r) => r.cpk !== null && Number.isFinite(r.cpk));
  if (valid.length === 0) {
    lines.push('- 本次数据缺少可用规格限，无法给出能力结论。');
  } else {
    const worst = valid.reduce((a, b) => ((b.cpk ?? 0) < (a.cpk ?? 0) ? b : a));
    const failing = valid.filter((r) => (r.cpk ?? 0) < 1.33);
    lines.push(
      `- 共分析 ${valid.length} 个特性，其中 ${failing.length} 个 Cpk < 1.33，需重点关注。`,
    );
    lines.push(
      `- 能力最低特性为「${worst.characteristic}」（Cpk=${fmtIndex(worst.cpk)}，判定：${capabilityVerdict(worst)}）。`,
    );
  }
  if (model.defectStats.length > 0) {
    const top = model.defectStats[0];
    lines.push(
      `- 不良类型以「${top.defectType}」为主（${top.count} 件，占比 ${fmtNumber(top.ratio, 2)}%）；` +
        (model.defectStats.length >= 3
          ? `前 3 类累计占比 ${fmtNumber(model.defectStats[2].cumRatio, 2)}%，符合柏拉图 80/20 聚焦原则。`
          : '关注该类不良的根因。'),
    );
  } else {
    lines.push('- 本次未导入不良记录，无法进行柏拉图分析。');
  }
  return lines.join('\n');
}

/**
 * 生成「建议」小节文字。
 *
 * @param model 报表模型
 * @returns 建议文本（≤3 条，优先级排序）
 */
export function buildSuggestions(model: ReportModel): string {
  const lines: string[] = [];
  const valid = model.cpkSummary.filter((r) => r.cpk !== null && Number.isFinite(r.cpk));
  const failing = valid.filter((r) => (r.cpk ?? 0) < 1.33).sort((a, b) => (a.cpk ?? 0) - (b.cpk ?? 0));

  if (failing.length > 0) {
    lines.push(
      `1. 【高】针对「${failing[0].characteristic}」开展过程能力改善（Cpk=${fmtIndex(failing[0].cpk)}）：` +
        `优先核查是否规格中心偏离（Ca=${fmtIndex(failing[0].ca)}）还是变异过大（Cp=${fmtIndex(failing[0].cp)}）。`,
    );
  }
  if (model.defectStats.length > 0) {
    lines.push(
      `2. 【中】对首要不良类型「${model.defectStats[0].defectType}」执行 5Why / 鱼骨图根因分析，` +
        '并锁定控制措施。',
    );
  }
  lines.push(
    '3. 【低】建立日常 SPC 监控：对关键特性持续绘制控制图，发现判异立即停线复测。',
  );
  return lines.slice(0, 3).join('\n');
}

/**
 * 由报表模型生成完整 Markdown 报告。
 *
 * @param model 报表中间模型
 * @param userNote 用户可选备注
 * @returns Markdown 文本
 */
export function buildMarkdownReport(model: ReportModel, userNote = ''): string {
  const generated = new Date(model.generatedAt);
  const generatedText = Number.isNaN(generated.getTime())
    ? model.generatedAt
    : generated.toLocaleString('zh-CN');

  const sections: string[] = [];
  sections.push(`# 质量分析报告 —— ${model.projectName}`);
  sections.push(`> 生成时间：${generatedText}`);
  if (userNote.trim().length > 0) {
    sections.push(`> 备注：${userNote.trim()}`);
  }

  sections.push('## 一、摘要');
  sections.push(
    `本报告基于 ${model.cpkSummary.length} 个特性的过程能力分析与 ${model.defectStats.length} 类不良统计生成。`,
  );
  if (model.warnings.length > 0) {
    sections.push(`\n> ⚠️ 数据提示：${model.warnings.join('；')}。`);
  }

  sections.push('## 二、能力指数汇总');
  sections.push(buildCpkTable(model.cpkSummary));

  sections.push('## 三、不良统计（柏拉图口径）');
  sections.push(buildDefectTable(model.defectStats));

  sections.push('## 四、结论');
  sections.push(buildConclusions(model));

  sections.push('## 五、建议');
  sections.push(buildSuggestions(model));

  sections.push('---');
  sections.push(
    '_本报告由 Hogo-QA-tool 离线生成；原始数据全程未离开本机。若复制本报告交由 AI 润色，' +
      '请注意其中可能包含特性名等业务信息。_',
  );

  return sections.join('\n\n');
}
