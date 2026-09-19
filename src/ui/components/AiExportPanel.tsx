/**
 * AiExportPanel —— 「AI 分析导出」面板（P4-B 新增，用户需求）。
 *
 * 用户原话：「希望新增一个 AI 导出功能，必须要接入 LLM，导出的报表每个模块都有
 * AI 分析，可以选择 AI 分析方向」。
 *
 * 面板职责（只做接线，业务在 services 里）：
 *  1. 分析方向：勾选式，至少保留 1 条（全不选时 prompt 没有约束，模型会自由发挥）；
 *  2. 触发生成：串行调用每个有数据的报表模块，实时显示进度；
 *  3. 结果展示：每模块一段，失败/跳过的模块也**显式列出原因**（不静默吞掉）；
 *  4. 导出出口：Markdown（适合贴邮件/纪要）、Excel（追加「AI 分析」sheet，
 *     与数据表同一个文件交付）与 Word(.docx)（真正排好版的标题层级 / 项目符号 / 表格，
 *     用户反馈 Excel 里长文不可读）；
 *  5. 离线 / 未配置：给出明确说明与「去设置」入口，按钮禁用，绝不假装成功。
 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  FormGroup,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { ANALYSIS_FOCUSES } from '@/services/ai/analysisFocus';
import { runReportAnalysis, type RunReportAnalysisRequest } from '@/services/ai/reportAnalysis';
import type { ReportModuleExtras } from '@/services/ai/reportModules';
import type { ReportModel } from '@/data/exporter/reportModel';
import { useAiReportStore } from '@/store/aiReportStore';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import {
  collectChartImages,
  downloadBlob,
  exportAiReportMarkdown,
  exportAiReportWord,
  exportExcelReportDetailed,
} from '@/services/report';
import { analysisSignature, toAiSheetRows } from '@/services/report';

export interface AiExportPanelProps {
  /** 报表中间模型；null = 无数据。 */
  model: ReportModel | null;
  /** 控制图模块的补充信息（报表页已算好的判异结果）。 */
  extras?: ReportModuleExtras;
  /** 可注入的分析执行器（用例断言用；默认走真实 `runReportAnalysis`）。 */
  runner?: (req: RunReportAnalysisRequest) => ReturnType<typeof runReportAnalysis>;
}

/** 分析方向勾选区。 */
function FocusPicker(): ReactElement {
  const focusIds = useAiReportStore((s) => s.focusIds);
  const toggleFocus = useAiReportStore((s) => s.toggleFocus);
  const running = useAiReportStore((s) => s.status === 'running');
  return (
    <FormGroup data-testid="ai-focus-group">
      <Stack direction="row" flexWrap="wrap" useFlexGap columnGap={2}>
        {ANALYSIS_FOCUSES.map((f) => (
          <FormControlLabel
            key={f.id}
            control={
              <Checkbox
                size="small"
                checked={focusIds.includes(f.id)}
                disabled={running}
                onChange={() => toggleFocus(f.id)}
                inputProps={{ 'data-testid': `ai-focus-${f.id}` } as never}
              />
            }
            label={
              <Box>
                <Typography variant="body2" fontWeight={600} component="span">
                  {f.label}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  {f.hint}
                </Typography>
              </Box>
            }
          />
        ))}
      </Stack>
    </FormGroup>
  );
}

/** AI 分析结果列表。 */
function ResultList(): ReactElement | null {
  const analyses = useAiReportStore((s) => s.analyses);
  if (analyses.length === 0) {
    return null;
  }
  return (
    <Stack spacing={1.5} data-testid="ai-results">
      {analyses.map((a) => (
        <Box
          key={a.moduleId}
          data-testid={`ai-result-${a.moduleId}`}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="subtitle2" fontWeight={600}>
              {a.title}
            </Typography>
            {a.ok ? (
              <Chip size="small" color="success" label="已生成" />
            ) : (
              <Chip
                size="small"
                color="warning"
                label={a.skipReason ? '未生成' : '失败'}
              />
            )}
            {a.ok && a.model ? (
              <Chip size="small" variant="outlined" label={a.model} />
            ) : null}
          </Stack>
          {a.ok ? (
            <Typography
              variant="body2"
              component="pre"
              data-testid={`ai-text-${a.moduleId}`}
              sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', m: 0 }}
            >
              {a.markdown}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary" data-testid={`ai-text-${a.moduleId}`}>
              {a.errorMessage ?? a.skipReason ?? '未知原因'}
            </Typography>
          )}
        </Box>
      ))}
    </Stack>
  );
}

/**
 * 渲染 AI 分析导出面板。
 *
 * @param props 组件属性
 * @returns 面板元素
 */
export default function AiExportPanel({
  model,
  extras,
  runner = runReportAnalysis,
}: AiExportPanelProps): ReactElement {
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const appendAiUsageLog = useProjectStore((s) => s.appendAiUsageLog);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const mode = useSettingsStore((s) => s.mode);
  const modeReason = useSettingsStore((s) => s.modeReason);

  const focusIds = useAiReportStore((s) => s.focusIds);
  const status = useAiReportStore((s) => s.status);
  const analyses = useAiReportStore((s) => s.analyses);
  const storedSignature = useAiReportStore((s) => s.signature);
  const progressTitle = useAiReportStore((s) => s.progressTitle);
  const progressDone = useAiReportStore((s) => s.progressDone);
  const progressTotal = useAiReportStore((s) => s.progressTotal);
  const runError = useAiReportStore((s) => s.error);
  const startRun = useAiReportStore((s) => s.startRun);
  const setProgress = useAiReportStore((s) => s.setProgress);
  const finishRun = useAiReportStore((s) => s.finishRun);
  const clear = useAiReportStore((s) => s.clear);
  const [busy, setBusy] = useState(false);

  const running = status === 'running' || busy;
  const aiReady = mode === 'ai' && aiConfig.baseUrl.trim().length > 0;
  const currentSignature = useMemo(
    () => (model ? analysisSignature(model, focusIds) : ''),
    [model, focusIds],
  );
  const stale = storedSignature !== null && storedSignature !== currentSignature;
  const hasResults = analyses.length > 0;

  /** 生成 AI 分析。 */
  const handleGenerate = async (): Promise<void> => {
    if (!model) {
      pushToast('无可用数据，无法生成 AI 分析', 'warning');
      return;
    }
    if (!aiReady) {
      pushToast('AI 未就绪，请先在「设置」页配置 Base URL 与模型名', 'warning');
      return;
    }
    const signature = currentSignature;
    startRun(signature);
    setBusy(true);
    try {
      const result = await runner({
        model,
        focusIds,
        aiConfig: {
          baseUrl: aiConfig.baseUrl,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
        },
        maxTokens: aiConfig.maxTokens,
        disableThinking: aiConfig.disableThinking,
        ...(extras ? { extras } : {}),
        onProgress: ({ done, total, title }) => setProgress(done, total, title),
      });
      for (const entry of result.usage) {
        appendAiUsageLog(entry);
      }
      const usedModel = result.analyses.find((a) => a.ok)?.model ?? aiConfig.model;
      finishRun(signature, result.analyses, usedModel, result.abortedBy);
      const okCount = result.analyses.filter((a) => a.ok).length;
      pushToast(
        result.abortedBy
          ? `AI 分析提前中止（${okCount}/${result.analyses.length} 个模块已完成）：${result.abortedBy}`
          : `AI 分析完成：${okCount}/${result.analyses.length} 个模块`,
        result.abortedBy ? 'warning' : 'success',
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      finishRun(signature, [], '', message);
      pushToast(`AI 分析失败：${message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 导出 Markdown。 */
  const handleExportMarkdown = (): void => {
    if (!model || !hasResults) {
      return;
    }
    try {
      const usedModel = analyses.find((a) => a.ok)?.model ?? aiConfig.model;
      const fileName = exportAiReportMarkdown(model, analyses, {
        model: usedModel,
        focusIds,
        generatedAt: new Date().toISOString(),
      });
      pushToast(`已导出 AI 分析报表：${fileName}`, 'success');
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 导出 Word(.docx)：把同一份分析渲染成真正的 Word 排版（标题层级 / 列表 / 表格）。 */
  const handleExportWord = (): void => {
    if (!model || !hasResults) {
      return;
    }
    try {
      const usedModel = analyses.find((a) => a.ok)?.model ?? aiConfig.model;
      const fileName = exportAiReportWord(model, analyses, {
        model: usedModel,
        focusIds,
        generatedAt: new Date().toISOString(),
      });
      pushToast(`已导出 Word 报表：${fileName}`, 'success');
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 导出 Excel（数据 + AI 分析 sheet + 图表 sheet）。 */
  const handleExportExcel = (): void => {
    if (!model) {
      return;
    }
    try {
      const { fileName, imageCount, aiModuleCount } = exportExcelReportDetailed(
        model,
        downloadBlob,
        collectChartImages,
        toAiSheetRows(analyses),
      );
      pushToast(
        `已导出 Excel：${fileName}（4 个数据 sheet + AI 分析 ${aiModuleCount} 个模块 + 内嵌 ${imageCount} 张图）`,
        'success',
      );
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <Card variant="outlined" data-testid="ai-export-panel">
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            AI 分析导出
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={aiConfig.model || '未配置模型'}
            data-testid="ai-export-model-chip"
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          勾选分析方向后，AI 会**逐模块**给出分析（CPK 汇总 / 不良统计 / 控制图 / 柏拉图 /
          能力图 / 原始尺寸）。只发送统计摘要，不发送逐条原始测量值。
        </Typography>

        {!aiReady ? (
          <Alert
            severity="info"
            data-testid="ai-export-offline"
            sx={{ mb: 1.5 }}
            action={
              <Button color="inherit" size="small" onClick={() => navigate('/settings')}>
                去设置
              </Button>
            }
          >
            {modeReason || '未配置 AI 服务，当前为离线模式。AI 分析导出需要可用的 LLM。'}
          </Alert>
        ) : null}

        <FocusPicker />

        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
          <Button
            variant="contained"
            size="small"
            data-testid="ai-generate"
            disabled={running || !aiReady || !model}
            onClick={() => void handleGenerate()}
          >
            {running ? '正在分析…' : '生成 AI 分析'}
          </Button>
          <Button
            variant="outlined"
            size="small"
            data-testid="ai-export-markdown"
            disabled={running || !hasResults}
            onClick={handleExportMarkdown}
          >
            导出 AI 报表（Markdown）
          </Button>
          <Button
            variant="outlined"
            size="small"
            data-testid="ai-export-word"
            disabled={running || !hasResults}
            onClick={handleExportWord}
          >
            导出 Word（.docx）
          </Button>
          <Button
            variant="outlined"
            size="small"
            data-testid="ai-export-excel"
            disabled={running || !model}
            onClick={handleExportExcel}
          >
            导出 Excel（含 AI 分析）
          </Button>
          <Button
            size="small"
            data-testid="ai-clear"
            disabled={running || (!hasResults && status === 'idle')}
            onClick={clear}
          >
            清除结果
          </Button>
        </Stack>

        {running ? (
          <Box sx={{ mt: 1.5 }} data-testid="ai-progress">
            <LinearProgress
              variant={progressTotal > 0 ? 'determinate' : 'indeterminate'}
              value={progressTotal > 0 ? (progressDone / progressTotal) * 100 : undefined}
            />
            <Typography variant="caption" color="text.secondary" data-testid="ai-progress-text">
              {progressTotal > 0
                ? `正在分析 ${Math.min(progressDone + 1, progressTotal)}/${progressTotal}：${progressTitle}`
                : '正在准备…'}
            </Typography>
          </Box>
        ) : null}

        {runError ? (
          <Alert severity="warning" sx={{ mt: 1.5 }} data-testid="ai-run-error">
            {runError}
          </Alert>
        ) : null}

        {stale ? (
          <Alert severity="info" sx={{ mt: 1.5 }} data-testid="ai-stale">
            下方的 AI 分析对应的是**之前的数据或方向**，当前数据已变化，建议重新生成。
          </Alert>
        ) : null}

        <Box sx={{ mt: 2 }}>
          <ResultList />
        </Box>
      </CardContent>
    </Card>
  );
}
