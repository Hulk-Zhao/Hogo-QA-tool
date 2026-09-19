/**
 * useCapabilityAnalysis —— 订阅当前特性 + 分析配置，返回 memo 化的分析结果。
 *
 * 出处：架构文档 §2.8。UI 组件只读结果，重算全部在 selectCapability 内完成。
 */

import { useMemo } from 'react';
import { useProjectStore, findCharacteristic } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { selectCapability, type CapabilityAnalysis } from '@/store/selectors';

/**
 * 读取当前特性并计算能力分析结果。
 *
 * @returns { characteristic, analysis } —— 未选特性时 analysis 为 null
 */
export function useCapabilityAnalysis(): {
  characteristicId: string | null;
  analysis: CapabilityAnalysis | null;
} {
  const dataset = useProjectStore((s) => s.dataset);
  const selectedId = useProjectStore((s) => s.selectedCharacteristicId);
  const subgroupMode = useAnalysisStore((s) => s.subgroupMode);
  const subgroupCapacity = useAnalysisStore((s) => s.subgroupCapacity);
  const manualBoundaries = useAnalysisStore((s) => s.manualBoundaries);
  const sigmaMode = useAnalysisStore((s) => s.sigmaMode);
  const spec = useAnalysisStore((s) => s.spec);

  const characteristic = useMemo(
    () => findCharacteristic(dataset, selectedId),
    [dataset, selectedId],
  );

  const analysis = useMemo(
    () =>
      selectCapability(characteristic, {
        subgroupMode,
        subgroupCapacity,
        manualBoundaries,
        sigmaMode,
        spec,
      }),
    [characteristic, subgroupMode, subgroupCapacity, manualBoundaries, sigmaMode, spec],
  );

  return { characteristicId: selectedId, analysis };
}
