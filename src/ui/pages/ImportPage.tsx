/**
 * ImportPage —— 数据导入页（P0-15 / P0-16）。
 *
 * 出处：架构文档 §2.8、PRD P0-15/P0-16。
 *
 * 功能：
 * 1. 拖拽区 + 粘贴 CSV 页签；
 * 2. 导入后展示表头 / 列映射预览（可手改）；
 * 3. 校验结果区（特性数 / 测量数 / 缺陷类型数 / 剔除空值数）；
 * 4. 旧格式自动识别（别名表匹配，免改列名）。
 *
 * T02/T03 对接：解析全部改由真实数据层 `@/data/importer` 提供
 * （`parseXlsx` / `parseCsv` / `parseClipboard` + `autoMapColumns` + `buildModel`），
 * 本页不再持有任何解析逻辑，仅做「形状适配 + 展示」。页面交互与展示不变。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import {
  UploadFile as UploadFileIcon,
  ContentPaste as ContentPasteIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useProjectStore, type ImportValidation } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { useProjectPersistence } from '@/ui/hooks/useProjectPersistence';
import DataTable, { type DataTableColumn } from '@/ui/components/DataTable';
import StatCard from '@/ui/components/StatCard';
import { HogoError } from '@/data/errors';
import { parseXlsx } from '@/data/importer/xlsxImporter';
import { parseCsv } from '@/data/importer/csvImporter';
import { parseClipboard } from '@/data/importer/clipboardImporter';
import { autoMapColumns } from '@/data/importer/xlsxImporter';
import { buildModel } from '@/data/importer/buildModel';
import { requiredRoles } from '@/data/importer/columnAliases';
import type { ColumnMapping, FieldRole, ParsedSheet } from '@/data/importer/types';

/** 页面局部状态：解析后的表 + 映射。 */
interface ParsedState {
  fileName: string;
  sheet: ParsedSheet;
  /** 角色 → 列索引（-1 表示未映射）。 */
  mapping: ColumnMapping;
  /** defect sheet（旧工具双 sheet 格式时存在）。 */
  defectSheet: ParsedSheet | null;
  defectMapping: ColumnMapping | null;
  /** 是否旧格式自动识别（免改列名）。 */
  autoDetected: boolean;
  /** 是否为 xlsx（用于判定 sourceType）。 */
  isXlsx: boolean;
  /** 解析期告警（如超过 20 万测量值的性能提示，架构 §0.2 #9）。 */
  warnings: string[];
}

const COLUMN_NONE = -1;

/** 行预览用：把 ParsedSheet 行转成带行号的单元格字符串数组。 */
interface PreviewRow {
  lineNumber: number;
  cells: string[];
}

/** 解析错误提示（可定位到 sheet / 行 / 列）。 */
function describeImportError(err: unknown): string {
  if (err instanceof HogoError) {
    const detail = err.detail as { rowNumber?: number; column?: string } | undefined;
    if (detail?.rowNumber !== undefined) {
      const col = detail.column ? `，列「${detail.column}」` : '';
      return `${err.message}（第 ${detail.rowNumber} 行${col}）`;
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** 读取文件为 ArrayBuffer（xlsx）。 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** 读取文件为文本（csv / txt）。 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * 渲染数据导入页。
 *
 * @returns 页面元素
 */
export default function ImportPage(): ReactElement {
  const [tab, setTab] = useState(0);
  const [pasted, setPasted] = useState('');
  const [parsed, setParsed] = useState<ParsedState | null>(null);
  const [dragging, setDragging] = useState(false);

  const setDataset = useProjectStore((s) => s.setDataset);
  const dataset = useProjectStore((s) => s.dataset);
  const pushToast = useUiStore((s) => s.pushToast);
  const navigate = useNavigate();
  const { persist } = useProjectPersistence();

  /** 由解析状态构造校验统计（调用真实 buildModel，捕获错误）。 */
  const validation: ImportValidation | null = useMemo(() => {
    if (!parsed) {
      return null;
    }
    try {
      const built = buildModel({
        // 试算用占位 id：这里只为取计数，结果不落盘，真实项目 id 由 setDataset 分配。
        projectId: 'preview',
        datasetName: parsed.fileName || '粘贴数据',
        sourceType: parsed.isXlsx ? 'xlsx' : 'csv',
        rawFileName: parsed.fileName || '粘贴数据',
        dimension: { sheet: parsed.sheet, mapping: parsed.mapping },
        defect: parsed.defectSheet && parsed.defectMapping
          ? { sheet: parsed.defectSheet, mapping: parsed.defectMapping }
          : null,
      });
      return {
        characteristicCount: built.dataset.characteristics.length,
        measurementCount: built.totalMeasurements,
        defectTypeCount: built.dataset.defectRecords.length,
        nullCount: built.totalNullCount,
      };
    } catch {
      return { characteristicCount: 0, measurementCount: 0, defectTypeCount: 0, nullCount: 0 };
    }
  }, [parsed]);

  /** 从 SheetJS 解析输出构造页面状态（含自动映射）。 */
  const buildStateFromXlsx = (fileName: string, buf: ArrayBuffer): ParsedState | null => {
    const out = parseXlsx(buf);
    if (!out.dimensionSheet || out.dimensionSheet.rows.length === 0) {
      pushToast('xlsx 中未找到可用的 dimension（测量值）工作表。', 'warning');
      return null;
    }
    const dimMapping = out.dimensionMapping?.mapping ?? autoMapColumns(out.dimensionSheet, 'dimension').mapping;
    const autoDetected = (out.dimensionMapping?.missingRoles.length ?? 1) === 0;
    return {
      fileName,
      sheet: out.dimensionSheet,
      mapping: dimMapping,
      defectSheet: out.defectSheet,
      defectMapping: out.defectMapping?.mapping ?? null,
      autoDetected,
      isXlsx: true,
      warnings: out.warnings,
    };
  };

  /** 从 CSV / 粘贴文本构造页面状态。 */
  const buildStateFromText = (fileName: string, text: string, isPaste: boolean): ParsedState | null => {
    const out = isPaste ? parseClipboard(text) : parseCsv(text);
    if (out.sheet.header.length === 0 || out.sheet.rows.length === 0) {
      pushToast('未解析到有效数据，请检查内容是否为空。', 'warning');
      return null;
    }
    const autoDetected = out.mapping.missingRoles.length === 0;
    return {
      fileName,
      sheet: out.sheet,
      mapping: out.mapping.mapping,
      defectSheet: null,
      defectMapping: null,
      autoDetected,
      isXlsx: false,
      warnings: out.warnings,
    };
  };

  /** 应用解析结果到状态。 */
  const applyParsed = (name: string, text: string): void => {
    const st = buildStateFromText(name, text, true);
    setParsed(st);
    if (st) {
      pushToast(
        st.autoDetected ? '已按旧格式自动识别列名，无需修改。' : '未能自动识别列名，请手动映射。',
        st.autoDetected ? 'success' : 'info',
      );
    }
  };

  /** 处理文件选择 / 拖拽。 */
  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) {
      return;
    }
    const file = files[0];
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        const buf = await readFileAsArrayBuffer(file);
        const st = buildStateFromXlsx(file.name, buf);
        setParsed(st);
        if (st) {
          pushToast(
            st.autoDetected ? '已按旧格式自动识别列名，无需修改。' : '未能自动识别列名，请手动映射。',
            st.autoDetected ? 'success' : 'info',
          );
        }
      } else {
        const text = await readFileAsText(file);
        const st = buildStateFromText(file.name, text, false);
        setParsed(st);
        if (st) {
          pushToast(st.autoDetected ? '已自动识别列名。' : '未能自动识别列名，请手动映射。', 'info');
        }
      }
    } catch (err) {
      pushToast(describeImportError(err), 'error');
    }
  };

  /**
   * 确认导入。
   *
   * **导入即落盘**：此前本方法只更新内存切片（`setDataset`），从不写仓库，
   * 于是「项目库」永远是空的 —— 空态文案承诺「导入数据并保存后，项目会出现在
   * 此列表中」，但导入路径上根本不存在「保存」这个动作（见记忆第二十一节）。
   *
   * 落盘失败**不阻断**导入：数据已在内存里可用，`persist` 会给出失败提示，
   * 其余分析流程照常。
   */
  const handleConfirm = async (): Promise<void> => {
    if (!parsed) {
      return;
    }
    try {
      const built = buildModel({
        // 真实项目 id 由 `setDataset` 统一分配（见其实现注释）。
        projectId: 'preview',
        datasetName: parsed.fileName || '粘贴数据',
        sourceType: parsed.isXlsx ? 'xlsx' : 'csv',
        rawFileName: parsed.fileName || '粘贴数据',
        dimension: { sheet: parsed.sheet, mapping: parsed.mapping },
        defect: parsed.defectSheet && parsed.defectMapping
          ? { sheet: parsed.defectSheet, mapping: parsed.defectMapping }
          : null,
      });
      const ds = built.dataset;
      if (ds.characteristics.length === 0 || ds.characteristics.every((c) => c.measurements.length === 0)) {
        pushToast('未解析到有效测量值，请检查列映射是否正确。', 'error');
        return;
      }
      setDataset(ds);
      // 「导入成功 + 已保存」合并成一条提示（含真实数量），不重复弹两条。
      await persist({
        successMessage:
          `导入成功：${ds.characteristics.length} 个特性、` +
          `${built.totalMeasurements} 个测量值，已保存到项目库`,
      });
      navigate('/capability');
    } catch (err) {
      pushToast(`导入失败：${describeImportError(err)}`, 'error');
    }
  };

  /** 手动修改某角色映射。 */
  const updateRole = (role: FieldRole, index: number): void => {
    setParsed((prev) =>
      prev ? { ...prev, mapping: { ...prev.mapping, [role]: index }, autoDetected: false } : prev,
    );
  };

  const previewRows: PreviewRow[] = parsed
    ? parsed.sheet.rows.map((cells, idx) => ({
        lineNumber: parsed.sheet.firstDataRowNumber + idx,
        cells: cells.map((c) => (c === null ? '' : String(c))),
      }))
    : [];

  const previewColumns: DataTableColumn<PreviewRow>[] = parsed
    ? parsed.sheet.header.map((h, idx) => ({
        key: `col-${idx}`,
        header: h || `列 ${idx + 1}`,
        align: 'left',
        render: (row) => row.cells[idx] ?? '',
        dense: true,
      }))
    : [];

  const materialIdx = parsed?.mapping.material ?? COLUMN_NONE;
  const valueIdx = parsed?.mapping.value ?? COLUMN_NONE;
  const subgroupIdx = parsed?.mapping.subgroup ?? COLUMN_NONE;
  const missingRequired = parsed
    ? requiredRoles('dimension').filter((r) => parsed.mapping[r] === undefined || parsed.mapping[r] < 0)
    : [];

  return (
    <Stack spacing={2.5} data-testid="import-page">
      <Typography variant="h6" fontWeight={600}>
        数据导入
      </Typography>

      <Card variant="outlined">
        <CardContent>
          <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ mb: 2 }}>
            <Tab icon={<UploadFileIcon />} iconPosition="start" label="文件导入" />
            <Tab icon={<ContentPasteIcon />} iconPosition="start" label="粘贴 CSV" />
          </Tabs>

          {tab === 0 ? (
            <Box
              data-testid="drop-zone"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void handleFiles(e.dataTransfer.files);
              }}
              sx={{
                border: '2px dashed',
                borderColor: dragging ? 'primary.main' : 'divider',
                borderRadius: 2,
                p: 4,
                textAlign: 'center',
                bgcolor: dragging ? 'primary.light' : 'transparent',
                transition: 'all 0.15s',
              }}
            >
              <UploadFileIcon sx={{ fontSize: 44, color: 'text.disabled' }} />
              <Typography variant="body1" sx={{ mt: 1 }}>
                将 CSV / Excel 文件拖拽到此处
              </Typography>
              <Typography variant="caption" color="text.secondary">
                支持旧工具双 sheet 格式，列名免修改
              </Typography>
              <Box sx={{ mt: 2 }}>
                <Button variant="outlined" component="label">
                  选择文件
                  <input
                    type="file"
                    hidden
                    accept=".csv,.xlsx,.xls,.txt"
                    onChange={(e) => void handleFiles(e.target.files)}
                  />
                </Button>
              </Box>
            </Box>
          ) : (
            <Stack spacing={1}>
              <TextField
                label="粘贴 CSV 文本（含表头，第一行为列名）"
                multiline
                minRows={6}
                fullWidth
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={'物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05'}
                inputProps={{ 'data-testid': 'paste-input' }}
              />
              <Box>
                <Button
                  variant="contained"
                  disabled={pasted.trim().length === 0}
                  onClick={() => applyParsed('粘贴数据', pasted)}
                >
                  解析
                </Button>
              </Box>
            </Stack>
          )}
        </CardContent>
      </Card>

      {parsed ? (
        <>
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  列映射预览
                </Typography>
                <Chip
                  size="small"
                  icon={<CheckCircleIcon />}
                  label={parsed.autoDetected ? '旧格式自动识别' : '手动映射'}
                  color={parsed.autoDetected ? 'success' : 'default'}
                  variant="outlined"
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="map-char-label">特性列</InputLabel>
                  <Select
                    labelId="map-char-label"
                    label="特性列"
                    value={materialIdx}
                    onChange={(e) => updateRole('material', Number(e.target.value))}
                  >
                    {parsed.sheet.header.map((h, idx) => (
                      <MenuItem key={`c-${idx}`} value={idx}>
                        {h || `列 ${idx + 1}`}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="map-value-label">测量值列</InputLabel>
                  <Select
                    labelId="map-value-label"
                    label="测量值列"
                    value={valueIdx}
                    onChange={(e) => updateRole('value', Number(e.target.value))}
                  >
                    {parsed.sheet.header.map((h, idx) => (
                      <MenuItem key={`v-${idx}`} value={idx}>
                        {h || `列 ${idx + 1}`}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="map-sub-label">子组列（可选）</InputLabel>
                  <Select
                    labelId="map-sub-label"
                    label="子组列（可选）"
                    value={subgroupIdx}
                    onChange={(e) => updateRole('subgroup', Number(e.target.value))}
                  >
                    <MenuItem value={COLUMN_NONE}>无</MenuItem>
                    {parsed.sheet.header.map((h, idx) => (
                      <MenuItem key={`s-${idx}`} value={idx}>
                        {h || `列 ${idx + 1}`}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              {missingRequired.length > 0 ? (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  尚缺必需列映射：{missingRequired.join('、')}。请在上方选择对应列。
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
                校验结果
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
                  gap: 1.5,
                }}
              >
                <StatCard label="特性数" value={validation?.characteristicCount ?? 0} />
                <StatCard label="测量数" value={validation?.measurementCount ?? 0} />
                <StatCard label="缺陷类型数" value={validation?.defectTypeCount ?? 0} />
                <StatCard
                  label="剔除空值数"
                  value={validation?.nullCount ?? 0}
                  alert={(validation?.nullCount ?? 0) > 0}
                  hint={(validation?.nullCount ?? 0) > 0 ? '空值已从计算中剔除' : '无空值'}
                />
              </Box>
              {validation && validation.characteristicCount > 0 && validation.measurementCount === 0 ? (
                <Alert severity="error" sx={{ mt: 2 }}>
                  未解析到有效测量值，请检查「测量值列」映射是否正确。
                </Alert>
              ) : null}
              {parsed.warnings.length > 0 ? (
                <Stack spacing={1} sx={{ mt: 2 }} data-testid="import-warnings">
                  {parsed.warnings.map((w, idx) => (
                    <Alert severity="warning" key={`warn-${idx}`}>
                      {w}
                    </Alert>
                  ))}
                </Stack>
              ) : null}
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                数据预览（前 50 行）
              </Typography>
              <DataTable
                columns={previewColumns}
                rows={previewRows.slice(0, 50)}
                rowKey={(r) => `row-${r.lineNumber}`}
                maxHeight={320}
                emptyContent="无数据"
                data-testid="import-preview-table"
              />
            </CardContent>
          </Card>

          <Divider />
          <Stack direction="row" spacing={1.5}>
            <Button
              variant="contained"
              onClick={() => void handleConfirm()}
              disabled={!validation || validation.measurementCount === 0}
            >
              确认导入并分析
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              onClick={() => {
                setParsed(null);
                setPasted('');
              }}
            >
              取消
            </Button>
          </Stack>
        </>
      ) : (
        <Alert severity="info">
          尚未导入数据。
          {dataset
            ? `当前已存在数据集「${dataset.name}」，重新导入会新建一个项目。`
            : '请拖拽文件或粘贴 CSV。'}
        </Alert>
      )}
    </Stack>
  );
}
