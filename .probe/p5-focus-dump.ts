import { BENCHMARK_CHARACTERISTICS } from '@/core/__tests__/fixtures/sampleDimension';
import { buildReportModel } from '@/data/exporter/reportModel';
import { buildModuleMessages } from '@/services/ai/reportAnalysis';
import { buildReportModules } from '@/services/ai/reportModules';
import { DEFAULT_FOCUS_IDS } from '@/services/ai/analysisFocus';
import type { Dataset, Project } from '@/data/schema';

const characteristics = BENCHMARK_CHARACTERISTICS.map((c, ci) => ({
  id: `c${ci}`, datasetId: 'ds1', name: c.name, specLimits: c.spec,
  measurements: c.values.map((v, i) => ({ id: `m${ci}-${i}`, characteristicId: `c${ci}`, value: v, subgroupId: null, timestamp: null, batch: null, excluded: false, excludeReason: null })),
  subgroups: [], nullCount: 0, outlierFlags: [], preprocessConfigRef: null, measurementBlobRef: null,
}));
const dataset = {
  id: 'ds1', projectId: 'p1', name: 'd', sourceType: 'xlsx', importedAt: new Date().toISOString(),
  rawFileName: 'x.xlsx', characteristics,
  defectRecords: [{ id: 'd0', datasetId: 'ds1', defectType: '划伤', count: 12, category: null }],
} as unknown as Dataset;
const project = { id: 'p1', name: 'P', description: '', createdAt: '', updatedAt: '', schemaVersion: 1, datasets: [dataset], analysisConfigs: [], aiUsageLogs: [] } as unknown as Project;
const model = buildReportModel(project);
console.log('DEFAULT_FOCUS_IDS', JSON.stringify(DEFAULT_FOCUS_IDS));
const mods = buildReportModules(model, undefined);
for (const m of mods) {
  console.log('---', m.id, 'applicable=', JSON.stringify(m.applicableFocus), 'unavailable=', m.unavailable);
}
const defect = mods.find((m) => m.id === 'defect')!;
const msgs = buildModuleMessages(defect, DEFAULT_FOCUS_IDS, model.projectName);
console.log('=== USER MSG (defect) ===');
console.log(msgs[1].content);