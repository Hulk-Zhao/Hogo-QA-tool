/**
 * P5 真机端到端探针：真实数据 → 真实 LLM（本机 Ollama）→ 检查「摘要未提供」噪音是否消失。
 *
 * 注意：本机没有 DeepSeek Key，用同协议的本地 Ollama 走**同一段代码路径**
 * （chatCompletion → reportModules → payloadBuilder）。口径差异见报告。
 */
import { BENCHMARK_CHARACTERISTICS } from '@/core/__tests__/fixtures/sampleDimension';
import { buildReportModel } from '@/data/exporter/reportModel';
import { runReportAnalysis } from '@/services/ai/reportAnalysis';
import { DEFAULT_FOCUS_IDS } from '@/services/ai/analysisFocus';
import type { Dataset, Project } from '@/data/schema';

const characteristics = BENCHMARK_CHARACTERISTICS.map((c, ci) => ({
  id: `c${ci}`,
  datasetId: 'ds1',
  name: c.name,
  specLimits: c.spec,
  measurements: c.values.map((v, i) => ({
    id: `m${ci}-${i}`,
    characteristicId: `c${ci}`,
    value: v,
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
}));

const defectTypes: [string, number][] = [
  ['划伤', 12],
  ['尺寸超差', 8],
  ['毛刺', 4],
  ['装配不良', 2],
  ['其他', 1],
];

const dataset: Dataset = {
  id: 'ds1',
  projectId: 'p1',
  name: '基准数据',
  sourceType: 'xlsx',
  importedAt: new Date().toISOString(),
  rawFileName: 'quality_data.xlsx',
  characteristics,
  defectRecords: defectTypes.map(([defectType, count], i) => ({
    id: `d${i}`,
    datasetId: 'ds1',
    defectType,
    count,
    category: null,
  })),
};

const project: Project = {
  id: 'p1',
  name: '外壳长度项目',
  description: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  schemaVersion: 1,
  datasets: [dataset],
  analysisConfigs: [],
  aiUsageLogs: [],
};

const model = buildReportModel(project);
const started = Date.now();
const result = await runReportAnalysis({
  model,
  focusIds: DEFAULT_FOCUS_IDS,
  aiConfig: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' },
  maxTokens: 2048,
  disableThinking: true,
  onProgress: (info) => console.error(`[progress] ${info.done + 1}/${info.total} ${info.title}`),
});

const allText = result.analyses.map((a) => a.markdown ?? '').join('\n');
const report = {
  elapsedSec: Math.round((Date.now() - started) / 1000),
  requestCount: result.requestCount,
  abortedBy: result.abortedBy,
  modules: result.analyses.map((a) => ({
    id: a.moduleId,
    ok: a.ok,
    chars: (a.markdown ?? '').length,
    skipReason: a.skipReason,
    error: a.errorMessage,
    noiseHits: (a.markdown ?? '').split('摘要未提供').length - 1,
    sample: (a.markdown ?? '').slice(0, 120),
  })),
  totalNoiseHits: allText.split('摘要未提供').length - 1,
  cpkSentFieldsHasMean: result.analyses.find((a) => a.moduleId === 'cpk')?.sentFields?.includes('characteristics.mean') ?? null,
};
console.log(JSON.stringify(report, null, 1));