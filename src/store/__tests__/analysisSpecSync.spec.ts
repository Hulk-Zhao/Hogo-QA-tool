/**
 * 规格限编辑态与「导入规格限」的同步（本轮 P2-A）。
 *
 * 缺陷背景（已在真实浏览器复现）：能力页的 `spec` 是独立编辑态，从未与
 * `characteristic.specLimits` 同步。导入带 USL/LSL 的 CSV 后页面规格限仍为空
 * → Cp/Cpk 全显示 N/A 并提示「仅提供单侧规格」，而报表页对同一份数据能算出
 * Cpk=3.65 —— 同一份数据两个口径，用户被迫手输文件里已经有的规格限。
 *
 * 证伪立场：把 `setSpec` 里的 `specOverridden: true` 去掉、或让
 * `applyCharacteristicSpec` 不复位该标记，第 3/4 组用例即变红。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '../analysisStore';

/**
 * 模块加载瞬间的初始状态（**必须在任何 setState 之前取**）。
 *
 * 为什么单列这一条：beforeEach 的复位会掩盖真实默认值，而默认值本身有业务含义——
 * 若默认就是 specOverridden: true，新会话的规格限自动预填将**永不生效**。
 */
const INITIAL_STATE = useAnalysisStore.getState();

/** 导入数据里的规格限（模拟 CSV 的 USL/LSL 列）。 */
const IMPORTED = { usl: 50.2, lsl: 49.8, target: 50.0, unit: 'mm' };

describe('analysisStore —— 规格限同步（P2-A）', () => {
  it('新会话默认态：未覆盖（否则自动预填永不生效）', () => {
    expect(INITIAL_STATE.specOverridden).toBe(false);
    expect(INITIAL_STATE.spec).toEqual({ usl: null, lsl: null, target: null, unit: 'mm' });
  });

  beforeEach(() => {
    useAnalysisStore.setState({
      spec: { usl: null, lsl: null, target: null, unit: 'mm' },
      specOverridden: false,
    });
  });

  it('默认态：未覆盖，编辑态为空（等待跟随所选特性）', () => {
    const s = useAnalysisStore.getState();
    expect(s.specOverridden).toBe(false);
    expect(s.spec.usl).toBeNull();
    expect(s.spec.lsl).toBeNull();
  });

  it('applyCharacteristicSpec：填入导入规格限，且仍标记为「未覆盖」', () => {
    useAnalysisStore.getState().applyCharacteristicSpec(IMPORTED);
    const s = useAnalysisStore.getState();
    expect(s.spec).toEqual(IMPORTED);
    expect(s.specOverridden).toBe(false);
  });

  it('setSpec：用户手改任意字段即标记「已覆盖」（自动预填不得再动它）', () => {
    useAnalysisStore.getState().applyCharacteristicSpec(IMPORTED);
    useAnalysisStore.getState().setSpec({ usl: 50.5 });
    const s = useAnalysisStore.getState();
    expect(s.spec.usl).toBe(50.5);
    expect(s.spec.lsl).toBe(49.8);
    expect(s.specOverridden).toBe(true);
  });

  it('「恢复为导入规格」：复位为导入值并清除「已覆盖」', () => {
    useAnalysisStore.getState().applyCharacteristicSpec(IMPORTED);
    useAnalysisStore.getState().setSpec({ usl: 50.5, lsl: 49.5 });
    expect(useAnalysisStore.getState().specOverridden).toBe(true);

    useAnalysisStore.getState().applyCharacteristicSpec(IMPORTED);
    const s = useAnalysisStore.getState();
    expect(s.spec).toEqual(IMPORTED);
    expect(s.specOverridden).toBe(false);
  });

  it('单位缺失时回落 mm（避免出现空单位）', () => {
    useAnalysisStore.getState().applyCharacteristicSpec({ usl: 1, lsl: 0, target: null, unit: '' });
    expect(useAnalysisStore.getState().spec.unit).toBe('mm');
  });
});
