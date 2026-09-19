/**
 * AiAssistantPage —— AI 质量分析助手（P0-23；PRD §7.2；T05 验收要点 3/4）。
 *
 * 功能（6 个，架构 §8.3 + 第五轮需求 #12）：
 * 1. 解读当前控制图（chartExplain）：输出「问题子组/特性 + 可执行动作」；
 * 2. 解读能力分析（capExplain）；
 * 3. 改善建议（suggest，≤3 条按优先级）；
 * 4. 生成报告文字（report，Markdown）；
 * 5. 数据问答（qa，仅基于统计摘要）；
 * 6. **AI 全面诊断（fullDiagnosis）**：一键生成五节制 Markdown 诊断报告，
 *    结果写入 `diagnosisStore` **持久化**（需求明确「不要 useState」），
 *    支持复制与导出 .md 文件。
 *
 * 审计：每次请求都调用 `projectStore.appendAiUsageLog`，让设置页的
 * 「AI 使用审计」表反映真实请求（此前 buildUsageEntry 的返回值被直接丢弃，
 * 审计表永远为空 —— 属接线类缺陷）。
 *
 * 数据主权（架构 §8.2）：
 * - 每次请求前展示 `sentFields` 清单；
 * - 默认 scope=summary；勾选「允许发送原始数据」并**二次确认**后 scope=raw；
 * - 请求后展示本次发送范围（摘要/明细）。
 *
 * 离线模式：整页显示离线提示（见文件末尾 `AiAssistantPage`），不渲染助手 UI。
 */

import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  SmartToy as SmartToyIcon,
  Send as SendIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import type { ReactElement } from 'react';
import { buildCapabilitySummary, buildSubgroups, computeCapability } from '@/core';
import type { CapabilitySummaryInput } from '@/core';
import {
  buildDiagnosisMarkdown,
  buildFullDiagnosisRecord,
  buildPayload,
  buildUsageEntry,
  chatCompletion,
  diagnosisFileName,
  type AiFeature,
  type ChatCompletionOptions,
  type ChatMessage,
} from '@/services/ai';
import type { AiClientConfig } from '@/services/ai';
import { buildMarkdownReport } from '@/services/report/markdownReport';
import { downloadBlob } from '@/services/report';
import { buildReportModel } from '@/data/exporter/reportModel';
import { useProjectStore } from '@/store/projectStore';
import { useDiagnosisStore } from '@/store/diagnosisStore';
import { nextEntryId, useAiChatStore, type ChatEntry } from '@/store/aiChatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import EmptyState from '@/ui/components/EmptyState';
import ConfirmDialog from '@/ui/components/ConfirmDialog';
import { writeClipboard } from '@/ui/clipboard';

/** 快捷功能定义。 */
interface QuickAction {
  feature: AiFeature;
  label: string;
  /** 是否需要分析数据。 */
  needsAnalysis: boolean;
  /** 用户备注/问题占位。 */
  placeholder?: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { feature: 'fullDiagnosis', label: 'AI 全面诊断（一键）', needsAnalysis: true },
  { feature: 'chartExplain', label: '解读当前控制图', needsAnalysis: true },
  { feature: 'capExplain', label: '解读能力分析', needsAnalysis: true },
  { feature: 'suggest', label: '生成改善建议', needsAnalysis: true },
  { feature: 'report', label: '生成报告文字', needsAnalysis: true },
  { feature: 'qa', label: '数据问答', needsAnalysis: false, placeholder: '例如：当前哪个特性能力最差？' },
];


/**
 * 单特性统计摘要条目。
 *
 * 有两个来源、需要同一目标类型：
 * 1. 有数据 → `buildCapabilitySummary(...)` 返回的完整 `CapabilitySummaryInput`；
 * 2. 无数据 → 仅含 `characteristicName` 与 `n: 0` 的最小占位。
 *
 * 用 `Pick<..., 'characteristicName' | 'n'> & Partial<...>` 让两边类型对齐：
 * 完整能力摘要可赋值给它（多余字段被允许），占位对象亦可（其余字段可选）。
 * 这样无需把 `CapabilitySummaryInput` 强转成 `Record<string, unknown>`
 * （后者因缺少字符串索引签名而无法直接赋值）。
 */
type CharacteristicSummaryEntry = Pick<CapabilitySummaryInput, 'characteristicName' | 'n'> &
  Partial<CapabilitySummaryInput>;

/**
 * 由当前项目/数据集构造可发送的统计摘要。
 *
 * @returns 摘要对象（仅统计量，绝不含逐条原始值）
 */
function buildSummaryForFeature(
  projectName: string,
  dataset: { characteristics: { name: string; specLimits: unknown; measurements: { value: number; excluded: boolean }[] }[] } | null,
): Record<string, unknown> {
  if (!dataset || dataset.characteristics.length === 0) {
    return { projectName, characteristicCount: 0, totalMeasurements: 0 };
  }
  const chars: CharacteristicSummaryEntry[] = [];
  let total = 0;
  for (const c of dataset.characteristics) {
    const values = c.measurements.filter((m) => m.excluded !== true).map((m) => m.value);
    total += values.length;
    if (values.length === 0) {
      chars.push({ characteristicName: c.name, n: 0 });
      continue;
    }
    const subgroups = buildSubgroups(
      values.map((v, i) => ({ id: `m${i}`, value: v })),
      { mode: 'fixed', capacity: 5 },
    );
    const cap = computeCapability(values, c.specLimits as never, subgroups, { useImrFallback: true });
    chars.push(buildCapabilitySummary(cap, c.name));
  }
  return {
    projectName,
    characteristicCount: dataset.characteristics.length,
    totalMeasurements: total,
    characteristics: chars,
  };
}

/**
 * 渲染 AI 助手页。
 *
 * @returns 页面元素
 */
function AiAssistantContent(): ReactElement {
  const project = useProjectStore((s) => s.project);
  const dataset = useProjectStore((s) => s.dataset);
  const projectName = useProjectStore((s) => s.projectName);
  const appendAiUsageLog = useProjectStore((s) => s.appendAiUsageLog);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const pushToast = useUiStore((s) => s.pushToast);

  // 全面诊断结果：来自持久化 store，不在组件 state 里（需求 #12）。
  const fullDiagnosis = useDiagnosisStore((s) => s.fullDiagnosis);
  const setFullDiagnosis = useDiagnosisStore((s) => s.setFullDiagnosis);
  const clearFullDiagnosis = useDiagnosisStore((s) => s.clearFullDiagnosis);

  // 会话相关状态全部放 store（本轮 P3-B）：路由切换会卸载本组件，
  // 组件内 useState 会随之销毁 —— 这正是「回来记录就消失了」的原因。
  const entries = useAiChatStore((s) => s.entries);
  const question = useAiChatStore((s) => s.question);
  const setQuestion = useAiChatStore((s) => s.setQuestion);
  const loading = useAiChatStore((s) => s.loading);
  const setLoading = useAiChatStore((s) => s.setLoading);
  const allowRaw = useAiChatStore((s) => s.allowRaw);
  const setAllowRaw = useAiChatStore((s) => s.setAllowRaw);
  const appendEntry = useAiChatStore((s) => s.appendEntry);
  const clearChat = useAiChatStore((s) => s.clearChat);
  const [pendingRaw, setPendingRaw] = useState<AiFeature | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [diagnosisCopied, setDiagnosisCopied] = useState(false);
  const lastRequest = useRef<{ feature: AiFeature; note: string } | null>(null);

  const summary = useMemo(
    () => buildSummaryForFeature(projectName, dataset),
    [projectName, dataset],
  );

  /**
   * 执行一次 AI 请求（含二次确认已通过）。
   *
   * @param feature 功能
   * @param note 用户备注/问题
   * @param useRaw 是否发送原始明细
   */
  const runRequest = async (feature: AiFeature, note: string, useRaw: boolean): Promise<void> => {
    const rawData = useRaw
      ? {
          measurements:
            dataset?.characteristics.map((c) => ({
              characteristicName: c.name,
              values: c.measurements.map((m) => m.value),
            })) ?? [],
        }
      : undefined;

    const payload = buildPayload(feature, summary, useRaw, rawData, note);

    appendEntry({
      id: nextEntryId(),
      role: 'user',
      text: note || QUICK_ACTIONS.find((q) => q.feature === feature)?.label || feature,
    });
    setLoading(true);

    const config: AiClientConfig = {
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
    };
    const requestOptions: ChatCompletionOptions = { maxTokens: aiConfig.maxTokens };
    if (aiConfig.disableThinking) {
      // 关闭模型思考：避免不收敛的推理模型把输出配额全部耗在思考上而正文为空。
      requestOptions.reasoningEffort = 'none';
    }
    const response = await chatCompletion(config, payload.messages as ChatMessage[], requestOptions);

    // 记录审计（AiUsageLog）—— 必须真正写入 store，否则设置页审计表永远为空。
    const entry = buildUsageEntry(feature, payload.scope, response.model, response.ok);
    appendAiUsageLog(entry);

    // 全面诊断：仅成功且有正文时落盘，避免把错误信息当成「报告」持久化。
    if (feature === 'fullDiagnosis' && response.ok && response.content.trim().length > 0) {
      setFullDiagnosis(
        buildFullDiagnosisRecord(response.content, {
          model: response.model,
          scope: payload.scope,
          sentFields: payload.sentFields,
          projectName,
          characteristicCount: dataset?.characteristics.length ?? 0,
        }),
      );
    }
    // 正文为空但模型返回了推理内容时，把思考过程一并展示：
    // 让用户看到「模型确实在思考、只是配额被思考吃光」，而不是只收到一句无信息量的报错。
    const assistantText = response.ok
      ? response.content
      : response.reasoning
        ? `${response.errorMessage ?? '请求失败。'}\n\n（以下为模型思考过程，未构成有效正文；可将「最大输出 tokens」调大后重试）\n${response.reasoning}`
        : response.errorMessage ?? '请求失败。';
    appendEntry({
      id: nextEntryId(),
      role: 'assistant',
      text: assistantText,
      scope: entry.sentPayloadScope,
      sentFields: payload.sentFields,
      ok: response.ok,
      ...(response.serverDetail ? { serverDetail: response.serverDetail } : {}),
    });
    setLoading(false);
  };

  /**
   * 发起功能（raw 需二次确认）。
   *
   * @param feature 功能
   * @param note 备注
   */
  const handleFeature = (feature: AiFeature, note = ''): void => {
    if (allowRaw) {
      lastRequest.current = { feature, note };
      setPendingRaw(feature);
      return;
    }
    void runRequest(feature, note, false);
  };

  /** 复制助手回复。 */
  const copyEntry = async (entry: ChatEntry): Promise<void> => {
    try {
      await writeClipboard(entry.text);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setCopiedId(null);
    }
  };

  /** 导出全面诊断报告为 .md 文件（元信息头 + AI 正文）。 */
  const exportDiagnosis = (): void => {
    if (!fullDiagnosis) {
      return;
    }
    try {
      const markdown = buildDiagnosisMarkdown(fullDiagnosis);
      const buffer = new TextEncoder().encode(markdown).buffer as ArrayBuffer;
      downloadBlob(buffer, diagnosisFileName(fullDiagnosis), 'text/markdown;charset=utf-8');
      pushToast('已导出诊断报告（Markdown）', 'success');
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 复制全面诊断报告（含元信息头）。 */
  const copyDiagnosis = async (): Promise<void> => {
    if (!fullDiagnosis) {
      return;
    }
    try {
      await writeClipboard(buildDiagnosisMarkdown(fullDiagnosis));
      setDiagnosisCopied(true);
      setTimeout(() => setDiagnosisCopied(false), 1500);
    } catch {
      setDiagnosisCopied(false);
    }
  };

  /** 生成 Markdown 报告并作为一条助手消息插入。 */
  const insertReport = (): void => {
    if (!project) {
      return;
    }
    try {
      const model = buildReportModel(project);
      const md = buildMarkdownReport(model);
      appendEntry({ id: nextEntryId(), role: 'assistant', text: md, ok: true });
    } catch {
      appendEntry({ id: nextEntryId(), role: 'assistant', text: '项目不含数据集，无法生成报告。', ok: false });
    }
  };

  return (
    <Stack spacing={2.5} data-testid="ai-assistant-page">
      <Stack direction="row" spacing={1} alignItems="center">
        <SmartToyIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          AI 质量分析助手
        </Typography>
        <Chip size="small" label="AI 模式" color="primary" />
      </Stack>

      {dataset === null ? (
        <Alert severity="info">
          当前项目暂无数据。请先在「数据导入」页导入数据，再使用 AI 解读功能。
        </Alert>
      ) : null}

      {/* 快捷指令 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            快捷指令
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {QUICK_ACTIONS.filter((a) => a.feature !== 'qa').map((a) => (
              <Button
                key={a.feature}
                variant="outlined"
                size="small"
                disabled={a.needsAnalysis && dataset === null}
                onClick={() => handleFeature(a.feature)}
                data-testid={`ai-action-${a.feature}`}
              >
                {a.label}
              </Button>
            ))}
            <Button variant="outlined" size="small" onClick={insertReport} disabled={project === null}>
              插入 Markdown 报告
            </Button>
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          {/* 数据主权控制 */}
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={allowRaw}
                onChange={(e) => setAllowRaw(e.target.checked)}
                inputProps={{ 'aria-label': '允许发送原始数据' }}
              />
            }
            label="允许发送原始数据（默认仅发送统计摘要）"
          />
          <Typography variant="caption" display="block" color="text.secondary">
            勾选后每次请求仍需二次确认；默认仅发送统计摘要（数据主权 G3）。
          </Typography>
        </CardContent>
      </Card>

      {/* 全面诊断结果（持久化：刷新 / 切换路由 / 重挂载都不丢） */}
      {fullDiagnosis ? (
        <Card variant="outlined" data-testid="ai-full-diagnosis">
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1" fontWeight={600}>
                AI 全面诊断报告
              </Typography>
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label={`已保存 · ${fullDiagnosis.model || '未知模型'}`}
                data-testid="diagnosis-model-chip"
              />
              <Chip
                size="small"
                variant="outlined"
                color={fullDiagnosis.scope === 'raw' ? 'warning' : 'default'}
                label={fullDiagnosis.scope === 'raw' ? '已发送：摘要 + 明细' : '已发送：仅摘要'}
              />
              <Box sx={{ flexGrow: 1 }} />
              <Button size="small" startIcon={<CopyIcon />} onClick={() => void copyDiagnosis()}>
                {diagnosisCopied ? '已复制' : '复制'}
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={exportDiagnosis}
                data-testid="diagnosis-export"
              >
                导出 Markdown
              </Button>
              <Button
                size="small"
                color="inherit"
                onClick={clearFullDiagnosis}
                data-testid="diagnosis-clear"
              >
                清除
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              生成时间：{fullDiagnosis.generatedAt || '—'} · 项目：{fullDiagnosis.projectName || '未命名项目'} ·
              纳入特性数：{fullDiagnosis.characteristicCount}
            </Typography>
            <Typography
              variant="body2"
              component="pre"
              sx={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                mt: 1,
                maxHeight: 420,
                overflow: 'auto',
                m: 0,
              }}
              data-testid="diagnosis-content"
            >
              {fullDiagnosis.content}
            </Typography>
          </CardContent>
        </Card>
      ) : null}

      {/* 数据问答 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            数据问答（仅基于统计摘要）
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              fullWidth
              size="small"
              placeholder="例如：当前哪个特性能力最差？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              inputProps={{ 'aria-label': '数据问答输入' }}
            />
            <Button
              variant="contained"
              endIcon={<SendIcon />}
              disabled={loading || question.trim().length === 0}
              onClick={() => {
                const q = question.trim();
                if (q.length === 0) {
                  return;
                }
                setQuestion('');
                handleFeature('qa', q);
              }}
            >
              提问
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {/* 对话记录（状态在 aiChatStore：切页不丢；因此需要一个显式的清空入口） */}
      {entries.length === 0 ? (
        <EmptyState
          title="尚未发起 AI 请求"
          description="点击上方快捷指令，或输入问题开始。每次请求前会展示将发送的字段清单。对话记录在切换页面后仍会保留（刷新页面则清空）。"
        />
      ) : (
        <>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle2">对话记录</Typography>
            <Chip size="small" label={'共 ' + String(entries.length) + ' 条'} data-testid="ai-conversation-count" />
            <Box sx={{ flexGrow: 1 }} />
            <Button size="small" color="inherit" onClick={clearChat} data-testid="ai-clear-chat">
              清空对话
            </Button>
          </Stack>
          <Stack spacing={1.5} data-testid="ai-conversation">
          {entries.map((entry) => (
            <Card
              key={entry.id}
              variant="outlined"
              sx={{
                bgcolor: entry.role === 'user' ? 'action.hover' : 'background.paper',
                alignSelf: entry.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
              }}
            >
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    {entry.role === 'user' ? '我' : 'AI 助手'}
                  </Typography>
                  {entry.scope ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      color={entry.scope === 'raw' ? 'warning' : 'default'}
                      label={entry.scope === 'raw' ? '已发送：摘要 + 明细' : '已发送：仅摘要'}
                      data-testid="ai-scope-chip"
                    />
                  ) : null}
                  {entry.role === 'assistant' ? (
                    <Button
                      size="small"
                      startIcon={<CopyIcon />}
                      onClick={() => void copyEntry(entry)}
                    >
                      {copiedId === entry.id ? '已复制' : '复制'}
                    </Button>
                  ) : null}
                </Stack>
                <Typography
                  variant="body2"
                  component="pre"
                  sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', m: 0 }}
                >
                  {entry.text}
                </Typography>
                {entry.sentFields && entry.sentFields.length > 0 ? (
                  <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
                    发送字段：{entry.sentFields.join('、')}
                  </Typography>
                ) : null}
                {entry.serverDetail ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.5, display: 'block', fontFamily: 'monospace' }}
                    data-testid="ai-server-detail"
                  >
                    服务端原文：{entry.serverDetail}
                  </Typography>
                ) : null}
              </CardContent>
            </Card>
          ))}
          </Stack>
        </>
      )}

      {loading ? (
        <Typography variant="body2" color="text.secondary">
          AI 思考中…
        </Typography>
      ) : null}

      {/* 发送明细二次确认 */}
      <ConfirmDialog
        open={pendingRaw !== null}
        title="确认发送原始明细数据"
        confirmColor="warning"
        confirmText="确认发送"
        content={
          <Box>
            <Typography variant="body2" gutterBottom>
              你已开启「允许发送原始数据」。本次请求将把**逐条原始测量值**发送到外部 AI 服务，
              可能包含敏感生产数据。
            </Typography>
            <Typography variant="body2" color="text.secondary">
              是否确认继续？
            </Typography>
          </Box>
        }
        onConfirm={() => {
          const req = lastRequest.current;
          setPendingRaw(null);
          if (req) {
            void runRequest(req.feature, req.note, true);
          }
        }}
        onCancel={() => setPendingRaw(null)}
      />
    </Stack>
  );
}

/**
 * 渲染 AI 助手页（外层门控）。
 *
 * 页面级门控：离线模式下不渲染助手 UI，改为展示「离线提示 + 前往设置」，
 * 而不是渲染一个整体置灰的巨型表单（避免「空白/不可用面板」）。
 *
 * @returns 页面元素
 */
export default function AiAssistantPage(): ReactElement {
  const mode = useSettingsStore((s) => s.mode);

  if (mode !== 'ai') {
    return (
      <Stack spacing={2} data-testid="ai-assistant-offline">
        <Stack direction="row" spacing={1} alignItems="center">
          <SmartToyIcon color="disabled" />
          <Typography variant="h6" fontWeight={600} color="text.secondary">
            AI 质量分析助手
          </Typography>
        </Stack>
        <Alert severity="info" data-testid="ai-gate-disabled">
          当前为离线模式，AI 助手不可用。核心分析功能（能力分析 / 控制图 / 柏拉图 / 报表导出）
          全部不受影响。请前往「设置」配置 AI 服务后启用。
        </Alert>
      </Stack>
    );
  }

  return <AiAssistantContent />;
}
