/**
 * 全面诊断（fullDiagnosis）服务层回归测试 —— 第五轮 P0 修复 #12。
 *
 * 背景缺陷：全库 grep `fullDiagnosis` 零命中 —— 需求「AI 全面诊断」完全未实施。
 *
 * 本文件重点验证「新增 AiFeature 枚举值必须同步四处」这条项目铁律：
 *   ① `types.AiFeature`；② `payloadBuilder.FEATURE_LABEL`；
 *   ③ `payloadBuilder.FEATURE_SYSTEM_PROMPT`；④ `usageLog.USAGE_FEATURE_LABEL`。
 * 漏掉 ②/③ 会让请求里出现 `【任务】undefined`，漏掉 ④ 会让设置页用量表显示空白。
 *
 * 证伪立场：删除任一处同步（例如忘了给 FEATURE_SYSTEM_PROMPT 加 fullDiagnosis），
 * 第 1 组用例立即变红。
 */

import { describe, expect, it } from 'vitest';
import type { AiFeature } from '../types';
import { buildMessages, buildPayload } from '../payloadBuilder';
import { USAGE_FEATURE_LABEL } from '../usageLog';
import {
  buildDiagnosisMarkdown,
  buildFullDiagnosisRecord,
  diagnosisFileName,
  sanitizeFullDiagnosis,
} from '../diagnosisReport';

/** 全部功能枚举（新增功能必须同时加进这里与四处映射）。 */
const ALL_FEATURES: AiFeature[] = [
  'chartExplain',
  'capExplain',
  'suggest',
  'report',
  'qa',
  'fullDiagnosis',
];

describe('AiFeature 枚举同步（新增功能必须四处齐备）', () => {
  it.each(ALL_FEATURES)('%s 在 FEATURE_LABEL / SYSTEM_PROMPT / USAGE_FEATURE_LABEL 均有定义', (feature) => {
    // ②③：buildMessages 里若缺 label 会拼出「undefined」，缺 prompt 则 system 为空。
    const messages = buildMessages(feature, { n: 1 });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content.length).toBeGreaterThan(20);
    expect(messages[1].content).toContain('【任务】');
    expect(messages[1].content).not.toContain('undefined');
    // ④：用量表中文名必须非空。
    expect(USAGE_FEATURE_LABEL[feature]).toBeTruthy();
  });

  it('fullDiagnosis 的任务名与用量表名称为「全面诊断」语义', () => {
    const messages = buildMessages('fullDiagnosis', {});
    expect(messages[1].content).toContain('AI 全面诊断');
    expect(USAGE_FEATURE_LABEL.fullDiagnosis).toBe('全面诊断');
  });
});

describe('fullDiagnosis 系统提示词', () => {
  const prompt = buildMessages('fullDiagnosis', {})[0].content;

  it('要求五节固定结构（缺节即无法交付，故逐节点名断言）', () => {
    for (const section of ['总体结论', '过程能力盘点', '主要问题与疑似根因', '改善行动', '数据局限与风险提示']) {
      expect(prompt).toContain(section);
    }
  });

  it('包含防臆造约束，且明确禁止拿「数据未提供」当回答（P8 口径）', () => {
    // P8 起措辞从「不得臆造」升级为「严禁臆造」，同时新增一条硬约束：
    // 数据已经给全（points / violations / chartCatalogue 都在），
    // 不许再回答「摘要未提供…」—— 这正是用户报障时看到的红框那句话。
    expect(prompt).toMatch(/严[禁格]臆造/);
    expect(prompt).toMatch(/禁[止止][^。]{0,20}摘要未提供/);
    // 数据主权口径不变：明确告知「不发送也不需要原始测量明细」的边界。
    expect(prompt).toContain('不是原始测量值');
  });

  it('引用能力门槛 1.33 / 1.67（与能力页口径一致）', () => {
    expect(prompt).toContain('1.33');
    expect(prompt).toContain('1.67');
  });
});

describe('buildPayload —— fullDiagnosis 仍走摘要白名单', () => {
  it('默认只发摘要；未知字段被丢弃；scope=summary', () => {
    const payload = buildPayload('fullDiagnosis', {
      projectName: '质量日报',
      characteristicCount: 3,
      totalMeasurements: 360,
      characteristics: [{ characteristicName: '外壳长度', n: 120, cpk: 1.42 }],
      // 白名单外的字段必须被剥掉（数据主权）。
      measurements: [{ characteristicName: '外壳长度', values: [50.1, 50.2] }],
      secretInternalField: 'should-not-leak',
    });

    expect(payload.scope).toBe('summary');
    expect(payload.sentFields).toContain('projectName');
    expect(payload.sentFields).toContain('characteristics');
    expect(payload.sentFields).not.toContain('measurements');
    expect(payload.sentFields).not.toContain('secretInternalField');
    expect(payload.messages[1].content).not.toContain('should-not-leak');
  });
});

describe('buildFullDiagnosisRecord / buildDiagnosisMarkdown', () => {
  const record = buildFullDiagnosisRecord('## 一、总体结论\n过程整体受控。', {
    model: 'deepseek-chat',
    scope: 'summary',
    sentFields: ['projectName', 'characteristics'],
    projectName: '质量日报',
    characteristicCount: 3,
  });

  it('记录带上生成时间、模型、发送范围与字段清单（审计可追溯）', () => {
    expect(record.id).toMatch(/^diag-/);
    expect(record.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.model).toBe('deepseek-chat');
    expect(record.scope).toBe('summary');
    expect(record.sentFields).toEqual(['projectName', 'characteristics']);
    expect(record.content).toContain('过程整体受控');
  });

  it('导出 Markdown 含元信息头 + 正文 + 数据主权声明', () => {
    const md = buildDiagnosisMarkdown(record);
    expect(md.startsWith('# AI 全面诊断报告')).toBe(true);
    expect(md).toContain('项目：质量日报');
    expect(md).toContain('模型：deepseek-chat');
    expect(md).toContain('发送数据范围：仅统计摘要');
    expect(md).toContain('## 一、总体结论');
    expect(md).toContain('未使用逐条原始测量值');
  });

  it('raw 范围的声明与 summary 不同（不谎报发送范围）', () => {
    const rawRecord = { ...record, scope: 'raw' as const };
    expect(buildDiagnosisMarkdown(rawRecord)).toContain('摘要 + 明细');
  });

  it('P9 补：导出 Markdown 剥离 [[chart:…]] 引用标记（报告里没有渲染图表的位置）', () => {
    // 真实服务返回的报告里就带着这种标记（deepseek-flash 实测写了 4 处）——
    // 导出的 .md 会被用户直接交付，露出标记等于交付半成品。
    const withRefs = {
      ...record,
      content:
        '## 二、过程能力盘点\n\n[[chart:histogram:外壳长度]]\n\n均值 50.050643。\n\n' +
        '[[chart:control:外壳长度]]\n\n## 三、主要问题\n',
    };
    const md = buildDiagnosisMarkdown(withRefs);
    expect(md).not.toContain('[[chart:');
    expect(md).toContain('## 二、过程能力盘点');
    expect(md).toContain('均值 50.050643。');
    expect(md).toContain('## 三、主要问题');
    expect(md).toContain('未使用逐条原始测量值');
  });
  it('文件名安全化且为 .md（项目名含非法字符时不产生坏文件名）', () => {
    const name = diagnosisFileName({ ...record, projectName: 'A/B:C*D?E"F<G>H|I' });
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain('A_B_C_D_E_F_G_H_I');
  });
});

describe('sanitizeFullDiagnosis —— 脏数据一律视为「无记录」', () => {
  it.each([
    ['null', null],
    ['字符串', 'oops'],
    ['数组', []],
    ['空对象', {}],
    ['正文缺失', { id: 'x', model: 'm' }],
    ['正文空白', { content: '   ' }],
    ['正文非字符串', { content: 123 }],
  ])('%s → null（不抛异常、不把损坏内容渲染到页面）', (_label, dirty) => {
    expect(() => sanitizeFullDiagnosis(dirty)).not.toThrow();
    expect(sanitizeFullDiagnosis(dirty)).toBeNull();
  });

  it('字段级脏值逐项回落，正文保留', () => {
    const out = sanitizeFullDiagnosis({
      id: '',
      content: '# 报告',
      generatedAt: 12345,
      model: null,
      scope: 'weird',
      sentFields: ['a', 7, null, 'b'],
      projectName: undefined,
      characteristicCount: 'many',
    });
    expect(out).not.toBeNull();
    expect(out?.content).toBe('# 报告');
    expect(out?.id).toMatch(/^diag-/); // 空 id 重新生成
    expect(out?.generatedAt).toBe('');
    expect(out?.model).toBe('');
    expect(out?.scope).toBe('summary'); // 非法 scope 保守回落「仅摘要」
    expect(out?.sentFields).toEqual(['a', 'b']);
    expect(out?.projectName).toBe('');
    expect(out?.characteristicCount).toBe(0);
  });
});