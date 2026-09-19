/**
 * chartFactory 入口（架构文档 §2.4 文件列表契约）。
 *
 * 实际工厂实现位于 `controlChart.ts`，此处转发以保持文件契约。
 */

export {
  buildControlChart,
  sigmaByPointOf,
  type ControlChartInput,
  type VariablesChartInput,
  type ImrChartInput,
  type AttributesChartInput,
} from './controlChart';
