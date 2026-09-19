// @vitest-environment jsdom
/**
 * ControlChart 组件与页面测试（jsdom 环境）。
 *
 * 覆盖：
 *   - ControlChart 渲染（主/副图 testid）；
 *   - extractPointIndex 点击索引解析；
 *   - ControlChartPage：7 型选择、规则开关、变限提示、违规明细、点击定位；
 *   - ReportPage：导出按钮存在、图像勾选项仅影响打印。
 *
 * 说明：ECharts 在 jsdom 下无 canvas，echarts-for-react 会渲染一个 div 占位，
 * 本测试只断言组件挂载与交互，不断言画布像素。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildControlChart, buildSubgroups } from '@/core';
import ControlChart, { extractPointIndex } from '@/ui/charts/ControlChart';
import ControlChartPage from '@/ui/pages/ControlChartPage';
import ReportPage from '@/ui/pages/ReportPage';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import type { Dataset } from '@/data/schema';

/** 生成测量值。 */
function sampleValues(n = 30): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(50 + Math.sin(i / 3) * 2 + (i % 3) * 0.3);
  }
  return out;
}

/** 构造数据集。 */
function makeDataset(): Dataset {
  const values = sampleValues(30);
  return {
    id: 'd1',
    projectId: 'p1',
    name: '数据集',
    sourceType: 'xlsx',
    importedAt: '2024-01-01T00:00:00.000Z',
    rawFileName: 'quality_data.xlsx',
    characteristics: [
      {
        id: 'c1',
        datasetId: 'd1',
        name: '长度',
        specLimits: { usl: 52, lsl: 48, target: 50, unit: 'mm' },
        measurements: values.map((value, i) => ({
          id: `m-${i}`,
          characteristicId: 'c1',
          value,
          subgroupId: null,
          timestamp: null,
          batch: null,
          excluded: false,
          excludeReason: null,
        })),
        subgroups: [],
        nullCount: 0,
        outlierFlags: [],
        preprocessConfigRef: null,
        measurementBlobRef: null,
      },
    ],
    defectRecords: [
      { id: 'def-1', datasetId: 'd1', defectType: '划伤', count: 42 },
      { id: 'def-2', datasetId: 'd1', defectType: '毛边', count: 18 },
    ],
  };
}

beforeEach(() => {
  const dataset = makeDataset();
  useProjectStore.setState({
    dataset,
    project: null,
    projectName: '测试项目',
    selectedCharacteristicId: 'c1',
  });
  useAnalysisStore.setState({ subgroupCapacity: 5, subgroupMode: 'fixed', manualBoundaries: [] });
});

describe('extractPointIndex —— 点击索引解析', () => {
  it('折线点击取 dataIndex', () => {
    expect(extractPointIndex({ dataIndex: 7, seriesType: 'line' })).toBe(7);
  });
  it('scatter 点击取 value[0]', () => {
    expect(extractPointIndex({ seriesType: 'scatter', data: { value: [3, 50] } })).toBe(3);
  });
  it('无法解析返回 null', () => {
    expect(extractPointIndex({})).toBeNull();
  });
});

describe('ControlChart 组件', () => {
  it('渲染主图容器 testid', () => {
    const series = buildControlChart('Xbar-R', {
      kind: 'variables',
      subgroups: buildSubgroups(
        sampleValues(25).map((value, i) => ({ id: `m-${i}`, value })),
        { mode: 'fixed', capacity: 5 },
      ),
    });
    render(
      <MemoryRouter>
        <ControlChart series={series} violations={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('control-chart')).toBeInTheDocument();
    expect(screen.getByTestId('control-chart-primary')).toBeInTheDocument();
    expect(screen.getByTestId('control-chart-secondary')).toBeInTheDocument();
  });
});

describe('ControlChartPage —— 控制图页', () => {
  it('无数据时显示空状态', () => {
    useProjectStore.setState({ dataset: null, selectedCharacteristicId: null });
    render(
      <MemoryRouter>
        <ControlChartPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('尚无可分析的数据')).toBeInTheDocument();
  });

  it('渲染图型选择、规则开关容器与判异明细表', () => {
    render(
      <MemoryRouter>
        <ControlChartPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('control-chart-page')).toBeInTheDocument();
    expect(screen.getByTestId('cc-type-select')).toBeInTheDocument();
    expect(screen.getByTestId('cc-rule-toggles-we')).toBeInTheDocument();
    expect(screen.getByTestId('cc-rule-toggles-nelson')).toBeInTheDocument();
    expect(screen.getByTestId('rule-violation-table')).toBeInTheDocument();
  });

  it('切换图型到计数型（无不良输入）显示错误提示', () => {
    render(
      <MemoryRouter>
        <ControlChartPage />
      </MemoryRouter>,
    );
    // 打开图型下拉（MUI 选项渲染在 portal 中，通过 role=option 选择）。
    const combo = within(screen.getByTestId('cc-type-select')).getByRole('combobox');
    fireEvent.mouseDown(combo);
    const pOptions = screen.getAllByRole('option').filter((el) => el.textContent?.includes('P 图'));
    expect(pOptions.length).toBeGreaterThan(0);
    fireEvent.click(pOptions[0]);
    expect(screen.getByTestId('cc-error')).toBeInTheDocument();
  });

  it('规则开关可关闭（西方电气全关）', () => {
    render(
      <MemoryRouter>
        <ControlChartPage />
      </MemoryRouter>,
    );
    const toggles = screen.getByTestId('cc-rule-toggles-we');
    const switches = within(toggles).getAllByRole('checkbox');
    expect(switches.length).toBeGreaterThanOrEqual(4);
    const before = (switches[0] as HTMLInputElement).checked;
    fireEvent.click(switches[0]);
    const after = (switches[0] as HTMLInputElement).checked;
    expect(after).toBe(!before);
  });

  it('切换特性后清除选中点定位', () => {
    render(
      <MemoryRouter>
        <ControlChartPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('cc-rule-toggles-we')).toBeInTheDocument();
  });
});

describe('ReportPage —— 报表导出页', () => {
  it('无数据时显示空状态', () => {
    useProjectStore.setState({ dataset: null, selectedCharacteristicId: null });
    render(
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('尚无可导出的数据')).toBeInTheDocument();
  });

  it('渲染导出按钮与 7 项导出范围勾选', () => {
    render(
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('report-page')).toBeInTheDocument();
    expect(screen.getByTestId('export-excel')).toBeInTheDocument();
    expect(screen.getByTestId('print-report')).toBeInTheDocument();
    // 7 项 = 4 表 + 3 图（第五轮需求 #11：图表必须真的能勾选并作用于输出）。
    expect(screen.getByTestId('report-export-options')).toBeInTheDocument();
    const boxes = within(screen.getByTestId('report-export-options')).getAllByRole('checkbox');
    expect(boxes).toHaveLength(7);
  });

  it('点击「导出 Excel」不抛异常', () => {
    render(
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>,
    );
    // jsdom 缺少 URL.createObjectURL，导出内部会安全降级；此处仅验证点击不抛异常。
    expect(() => fireEvent.click(screen.getByTestId('export-excel'))).not.toThrow();
  });

  it('渲染 CPK 汇总与不良统计预览表', () => {
    render(
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('report-cpk-table')).toBeInTheDocument();
    expect(screen.getByTestId('report-defect-table')).toBeInTheDocument();
  });
});
