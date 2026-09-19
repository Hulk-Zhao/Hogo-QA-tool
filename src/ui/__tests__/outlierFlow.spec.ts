/**
 * 异常值两步确认状态流转测试（PRD P0-14）。
 *
 * 流程：detectOutliersFor（仅标注）→ toggleOutlierSelection（人工勾选）
 *       → confirmedExcludedIndices（取出已确认）→ resetOutliers（撤销）。
 *
 * 关键断言：**标注不自动删除**（confirmed 默认全 false）。
 * 不重复验证 core 的 Grubbs/IQR 公式（T01 职责）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '@/store/analysisStore';

/** 一段含明显离群点的数据（确保 Grubbs 能标注出候选）。 */
const VALUES = [10.0, 10.1, 10.05, 9.98, 10.02, 10.08, 9.95, 10.03, 10.01, 9.99, 50.0];

describe('异常值两步确认', () => {
  beforeEach(() => {
    useAnalysisStore.getState().resetOutliers();
    useAnalysisStore.getState().setOutlierMethod('grubbs');
  });

  it('步骤 1：标注后候选默认未确认（不自动删除）', () => {
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    const { outlierCandidates } = useAnalysisStore.getState();
    expect(outlierCandidates.length).toBeGreaterThan(0);
    expect(outlierCandidates.every((c) => c.confirmed === false)).toBe(true);
    expect(useAnalysisStore.getState().confirmedExcludedIndices()).toEqual([]);
  });

  it('步骤 2：勾选后进入 confirmedExcludedIndices', () => {
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    const target = useAnalysisStore.getState().outlierCandidates[0];
    useAnalysisStore.getState().toggleOutlierSelection(target.index);
    expect(useAnalysisStore.getState().confirmedExcludedIndices()).toContain(target.index);

    // 再次勾选取消
    useAnalysisStore.getState().toggleOutlierSelection(target.index);
    expect(useAnalysisStore.getState().confirmedExcludedIndices()).not.toContain(target.index);
  });

  it('全选 / 全不选', () => {
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    const count = useAnalysisStore.getState().outlierCandidates.length;
    useAnalysisStore.getState().setAllOutlierConfirmed(true);
    expect(useAnalysisStore.getState().confirmedExcludedIndices().length).toBe(count);
    useAnalysisStore.getState().setAllOutlierConfirmed(false);
    expect(useAnalysisStore.getState().confirmedExcludedIndices().length).toBe(0);
  });

  it('撤销：resetOutliers 清空候选与勾选', () => {
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    useAnalysisStore.getState().setAllOutlierConfirmed(true);
    useAnalysisStore.getState().resetOutliers();
    expect(useAnalysisStore.getState().outlierCandidates).toEqual([]);
    expect(useAnalysisStore.getState().confirmedExcludedIndices()).toEqual([]);
  });

  it('重新标注保留用户已确认的选择', () => {
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    const target = useAnalysisStore.getState().outlierCandidates[0];
    useAnalysisStore.getState().toggleOutlierSelection(target.index);
    // 再次标注（相同数据）
    useAnalysisStore.getState().detectOutliersFor(VALUES);
    const again = useAnalysisStore.getState().outlierCandidates.find((c) => c.index === target.index);
    expect(again?.confirmed).toBe(true);
  });

  it('无异常值数据 → 候选为空', () => {
    useAnalysisStore.getState().detectOutliersFor([1, 1, 1, 1, 1]);
    expect(useAnalysisStore.getState().outlierCandidates).toEqual([]);
  });
});

describe('子组容量边界', () => {
  it('容量限制在 2..25 整数', () => {
    useAnalysisStore.getState().setSubgroupCapacity(1);
    expect(useAnalysisStore.getState().subgroupCapacity).toBe(2);
    useAnalysisStore.getState().setSubgroupCapacity(100);
    expect(useAnalysisStore.getState().subgroupCapacity).toBe(25);
    useAnalysisStore.getState().setSubgroupCapacity(5);
    expect(useAnalysisStore.getState().subgroupCapacity).toBe(5);
  });
});
