// @vitest-environment jsdom
/**
 * 偏好持久化回归测试（永久）—— 第五轮 P0 修复 #4（判异开关落盘）。
 *
 * 背景缺陷：判异准则 12 条开关此前在 `ControlChartPage` 与 `SettingsPage`
 * 各持一份 `useState`，**用户改完开关刷新即丢**（第四轮已识别，第五轮仍未修）。
 *
 * 本文件独立验证三件事：
 * 1. `sanitizeRulesConfig` / `sanitizeUiPreferences` 的**逐字段**容错（旧版残留
 *    只存了部分规则、或用户手工篡改 localStorage，都不得把整份开关丢弃）；
 * 2. store 动作（`setRule` / `setRulesGroup` / `setExportOptions`）语义正确；
 * 3. 持久化**真的接线**：变更 → 落盘 → 重开模块 → bootstrap 还原。
 *
 * 证伪立场（破坏实现必须变红）：
 * - 若 `sanitizeRulesConfig` 改为「整份丢弃」或「不回落默认」，第 1 组用例变红；
 * - 若 `setRule` 退化为改整组、或 `setExportOptions` 覆盖整份，第 2 组变红；
 * - 若 `bootstrapPreferences` 去掉订阅或 hydrate，第 3 组变红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultToggleConfig } from '@/core';
import {
  CHART_OPTION_KEYS,
  DEFAULT_EXPORT_OPTIONS,
  TABLE_OPTION_KEYS,
} from '@/services/report/exportOptions';
import {
  PREFERENCES_STORAGE_KEY,
  currentPreferences,
  hydratePreferences,
  persistPreferences,
  sanitizeRulesConfig,
  sanitizeUiPreferences,
  useSettingsStore,
  type PreferencesPersistence,
} from '@/store/settingsStore';

describe('sanitizeRulesConfig —— 12 条开关逐条容错', () => {
  it('非对象（null / 字符串 / 数字 / 数组）→ 整体回落默认', () => {
    for (const dirty of [null, 'x', 42, [], undefined]) {
      expect(sanitizeRulesConfig(dirty)).toEqual(defaultToggleConfig());
    }
  });

  it('脏值逐条回落默认，而合法的 false 必须保留', () => {
    const out = sanitizeRulesConfig({
      westernElectric: { W1: false, W2: 'yes', W3: null, W4: 0 },
      nelson: { N5: false, N6: 1 },
    });
    // 用户显式关闭 → 必须保留，否则「关不掉的开关」是更严重的缺陷。
    expect(out.westernElectric.W1).toBe(false);
    expect(out.nelson.N5).toBe(false);
    // 脏值 → 回落默认（W 默认 true）。
    expect(out.westernElectric.W2).toBe(true);
    expect(out.westernElectric.W3).toBe(true);
    expect(out.westernElectric.W4).toBe(true);
    expect(out.nelson.N6).toBe(true);
    // 缺失项补齐（旧版本只持久化了部分规则的情形）。
    expect(out.nelson.N1).toBe(false);
    expect(out.nelson.N8).toBe(true);
  });

  it('显式 false 全组保留（全关状态可持久化）', () => {
    const allOff = sanitizeRulesConfig({
      westernElectric: { W1: false, W2: false, W3: false, W4: false },
      nelson: {
        N1: false,
        N2: false,
        N3: false,
        N4: false,
        N5: false,
        N6: false,
        N7: false,
        N8: false,
      },
    });
    expect(allOff.westernElectric).toEqual({ W1: false, W2: false, W3: false, W4: false });
    expect(Object.values(allOff.nelson).every((v) => v === false)).toBe(true);
  });
});

describe('sanitizeUiPreferences —— 组合载荷容错', () => {
  it('非对象 → null（调用方视为无偏好，回落默认）', () => {
    expect(sanitizeUiPreferences(null)).toBeNull();
    expect(sanitizeUiPreferences('x')).toBeNull();
    expect(sanitizeUiPreferences([])).toBeNull();
  });

  it('空对象 → 补齐为「默认开关 + 默认导出范围」', () => {
    const out = sanitizeUiPreferences({});
    expect(out).toEqual({
      rulesConfig: defaultToggleConfig(),
      exportOptions: DEFAULT_EXPORT_OPTIONS,
    });
  });

  it('导出范围旧版 2 字段结构读回后补齐为 7 项（不整份丢弃）', () => {
    const out = sanitizeUiPreferences({
      exportOptions: { includeChartImagesInPrint: false, includeTables: true },
    });
    expect(out?.exportOptions).toEqual(DEFAULT_EXPORT_OPTIONS);
  });
});

describe('settingsStore 偏好动作', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetPreferences();
  });

  it('setRule 只改指定规则，其余 11 条不受影响', () => {
    useSettingsStore.getState().setRule('N5', false);
    const { rulesConfig } = useSettingsStore.getState();
    expect(rulesConfig.nelson.N5).toBe(false);
    expect(rulesConfig.nelson.N6).toBe(true);
    expect(rulesConfig.westernElectric).toEqual(defaultToggleConfig().westernElectric);
  });

  it('setRulesGroup 只影响目标组（W 组全开 / N 组全关互不串扰）', () => {
    useSettingsStore.getState().setRulesGroup('nelson', false);
    let s = useSettingsStore.getState().rulesConfig;
    expect(Object.values(s.nelson).every((v) => v === false)).toBe(true);
    expect(Object.values(s.westernElectric).every((v) => v === true)).toBe(true);

    useSettingsStore.getState().setRulesGroup('westernElectric', false);
    s = useSettingsStore.getState().rulesConfig;
    expect(Object.values(s.westernElectric).every((v) => v === false)).toBe(true);
  });

  it('setExportOptions 为增量更新（不把未提及的项冲回默认）', () => {
    useSettingsStore.getState().setExportOptions({ cpkSummary: false });
    const opts = useSettingsStore.getState().exportOptions;
    expect(opts.cpkSummary).toBe(false);
    // 其余 6 项保持默认 true。
    for (const key of [...TABLE_OPTION_KEYS, ...CHART_OPTION_KEYS]) {
      if (key !== 'cpkSummary') {
        expect(opts[key]).toBe(true);
      }
    }
    // 单张图表也能单独关闭（需求 #11：导出范围可勾选到每一项）。
    useSettingsStore.getState().setExportOptions({ paretoChartImage: false });
    expect(useSettingsStore.getState().exportOptions.paretoChartImage).toBe(false);
    expect(useSettingsStore.getState().exportOptions.cpkSummary).toBe(false);
  });

  it('resetPreferences 同时恢复开关与导出范围', () => {
    useSettingsStore.getState().setRule('W1', false);
    useSettingsStore.getState().setExportOptions({ rawDefects: false });
    useSettingsStore.getState().resetPreferences();
    expect(useSettingsStore.getState().rulesConfig).toEqual(defaultToggleConfig());
    expect(useSettingsStore.getState().exportOptions).toEqual(DEFAULT_EXPORT_OPTIONS);
  });
});

describe('偏好持久化接线（注入持久层）', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetPreferences();
  });

  it('currentPreferences 返回当前切片（不含 AI 配置）', () => {
    useSettingsStore.getState().setRule('N8', false);
    const snap = currentPreferences();
    expect(snap.rulesConfig.nelson.N8).toBe(false);
    expect(Object.keys(snap).sort()).toEqual(['exportOptions', 'rulesConfig']);
  });

  it('persistPreferences 把当前偏好写入注入的持久层', () => {
    const save = vi.fn();
    const persistence: PreferencesPersistence = { load: () => null, save };
    useSettingsStore.getState().setExportOptions({ defectStats: false });

    persistPreferences(persistence);

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as { exportOptions: { defectStats: boolean } }).exportOptions.defectStats).toBe(false);
  });

  it('hydratePreferences 从注入的持久层读回偏好（并经过 sanitize）', () => {
    const persistence: PreferencesPersistence = {
      load: () => ({
        rulesConfig: { westernElectric: { W1: true, W2: true, W3: true, W4: true }, nelson: { N5: false } } as never,
        exportOptions: DEFAULT_EXPORT_OPTIONS,
      }),
      save: () => undefined,
    };

    hydratePreferences(persistence);

    const s = useSettingsStore.getState();
    expect(s.rulesConfig.nelson.N5).toBe(false);
    // 缺失的 11 条由 sanitize 补齐，不会变成 undefined。
    expect(s.rulesConfig.nelson.N6).toBe(true);
    expect(s.rulesConfig.westernElectric.W1).toBe(true);
  });
});

describe('偏好端到端持久化（bootstrapPreferences）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  /** 取一套全新的模块实例（模拟一次「冷启动」）。 */
  async function coldStart(): Promise<{
    store: typeof import('@/store/settingsStore');
    boot: typeof import('@/ui/bootstrap/settingsBootstrap');
  }> {
    const store = await import('@/store/settingsStore');
    const boot = await import('@/ui/bootstrap/settingsBootstrap');
    return { store, boot };
  }

  it('变更即落盘：setRule 后 localStorage 出现该开关（而非只改内存）', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapPreferences();

    store.useSettingsStore.getState().setRule('N7', false);

    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    expect(raw, '改开关后必须已落盘').not.toBeNull();
    const parsed = JSON.parse(raw as string) as { rulesConfig: { nelson: Record<string, boolean> } };
    expect(parsed.rulesConfig.nelson.N7).toBe(false);
  });

  it('导出范围勾选同样落盘', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapPreferences();

    store.useSettingsStore.getState().setExportOptions({ controlChartImage: false });

    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      exportOptions: Record<string, boolean>;
    };
    expect(parsed.exportOptions.controlChartImage).toBe(false);
  });

  it('写入 → 落盘 → 重开模块（内存归零）→ bootstrap 还原（刷新不丢）', async () => {
    // —— 会话 1：用户改开关并关掉柏拉图勾选 ——
    const s1 = await coldStart();
    s1.boot.bootstrapPreferences();
    s1.store.useSettingsStore.getState().setRule('W2', false);
    s1.store.useSettingsStore.getState().setExportOptions({ paretoChartImage: false });
    expect(localStorage.getItem(PREFERENCES_STORAGE_KEY)).not.toBeNull();

    // —— 会话 2：全新模块实例（内存为默认值），同一 localStorage ——
    vi.resetModules();
    const s2 = await coldStart();
    // 反向对照：新实例内存确实是默认值（证明还原来自持久层而非残留内存）。
    expect(s2.store.useSettingsStore.getState().rulesConfig).toEqual(defaultToggleConfig());
    expect(s2.store.useSettingsStore.getState().exportOptions).toEqual(DEFAULT_EXPORT_OPTIONS);

    s2.boot.bootstrapPreferences();
    // 关键：若 hydrate 未接线，此处仍为默认 → 断言失败（即用户看到的「刷新就丢」）。
    expect(s2.store.useSettingsStore.getState().rulesConfig.westernElectric.W2).toBe(false);
    expect(s2.store.useSettingsStore.getState().exportOptions.paretoChartImage).toBe(false);
  });

  it('启动读取脏偏好（字符串布尔 / 缺项）→ bootstrap 后回落默认而非崩溃', async () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        rulesConfig: { westernElectric: { W1: 'oops' } },
        exportOptions: { cpkSummary: 'yes' },
      }),
    );

    const { store, boot } = await coldStart();
    boot.bootstrapPreferences();

    const s = store.useSettingsStore.getState();
    expect(s.rulesConfig.westernElectric.W1).toBe(true);
    expect(s.rulesConfig.nelson.N5).toBe(true);
    expect(s.exportOptions).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it('幂等：重复 bootstrap 不抛错，且已有偏好不被冲回默认', async () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        rulesConfig: { westernElectric: { W1: false, W2: false, W3: false, W4: false } },
        exportOptions: { ...DEFAULT_EXPORT_OPTIONS, controlChartImage: false },
      }),
    );

    const { store, boot } = await coldStart();
    boot.bootstrapPreferences();
    boot.bootstrapPreferences();

    expect(store.useSettingsStore.getState().rulesConfig.westernElectric.W4).toBe(false);
    expect(store.useSettingsStore.getState().exportOptions.controlChartImage).toBe(false);
  });
});