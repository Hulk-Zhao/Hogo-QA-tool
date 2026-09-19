/**
 * SettingsPage —— 设置页（P0-22；PRD §7.2；T05 验收要点 1/5）。
 *
 * 内容：
 * 1. AI 配置（Base URL / API Key / 模型名 / 连通性测试 / 重试 / 是否允许发送原始数据）；
 * 2. 判异准则默认开关（西方电气 4 + 尼尔森 8）；
 * 3. 控制限常数表（n=2..25，D3/B3 无定义显示「—」而非 0）；
 * 4. 数据与隐私说明（数据主权）；
 * 5. AI 使用审计（AiUsageLog 列表）；
 * 6. 项目库管理入口。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ALL_RULE_IDS,
  EQUIVALENT_RULE,
  RULE_META,
  getAllConstantsRaw,
  MAX_SUBGROUP_N,
  MIN_SUBGROUP_N,
} from '@/core';
import { useSettingsStore, MIN_MAX_TOKENS } from '@/store/settingsStore';
import { buildStamp } from '@/ui/buildStamp';
import { useProjectStore } from '@/store/projectStore';
import { useAiAvailability } from '@/ui/hooks/useAiAvailability';
import { USAGE_FEATURE_LABEL, USAGE_SCOPE_LABEL } from '@/services/ai';

/** 常数表展示行。 */
interface ConstantRow {
  n: number;
  A2: number;
  A3: number;
  D3: number | null;
  D4: number;
  B3: number | null;
  B4: number;
  d2: number;
  E2: number;
  c4: number;
}

/** 数值展示：null → 「—」。 */
function cell(value: number | null): string {
  return value === null || value === undefined ? '—' : String(value);
}

/**
 * 判断 baseUrl 是否指向本机（localhost / 127.0.0.1 / [::1]）。
 *
 * 用于离线单文件版（`file://`）的 CORS 指向性提示：浏览器跨源策略会拦截
 * `file://` 页面直连本机 AI 服务，这是环境限制而非配置错误。
 *
 * @param baseUrl AI 服务地址
 * @returns 是否为本机地址
 */
function isLocalHostBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase();
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(normalized);
}

/**
 * 渲染设置页。
 *
 * @returns 页面元素
 */
export default function SettingsPage(): ReactElement {
  const navigate = useNavigate();
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const setAiConfig = useSettingsStore((s) => s.setAiConfig);
  const applyProbeResult = useSettingsStore((s) => s.applyProbeResult);
  // 审计记录唯一真源 = projectStore 切片（AI 助手每次请求后写入）。
  const usageLogs = useProjectStore((s) => s.aiUsageLogs);
  const { mode, probing, reason, message, retry } = useAiAvailability();

  /**
   * 判异准则开关与控制图页**同源**（settingsStore.rulesConfig）。
   * 第五轮 P0 修复：此前是本页一份 `useState`，改完刷新即丢。
   */
  const toggles = useSettingsStore((s) => s.rulesConfig);
  const setRule = useSettingsStore((s) => s.setRule);
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'fail'>('idle');

  const constants = useMemo<ConstantRow[]>(() => {
    const raw = getAllConstantsRaw();
    const rows: ConstantRow[] = [];
    for (let n = MIN_SUBGROUP_N; n <= MAX_SUBGROUP_N; n += 1) {
      const r = raw[n];
      if (!r) {
        continue;
      }
      rows.push({ n, ...r });
    }
    return rows;
  }, []);

  const handleTest = async (): Promise<void> => {
    setTestResult('idle');
    const result = await retry();
    if (result.mode === 'ai') {
      setTestResult('ok');
    } else {
      setTestResult('fail');
    }
  };

  // 离线单文件版（file://）直连本机 AI 服务被浏览器跨源策略拦截时的针对性提示。
  const showLocalFileHint =
    testResult === 'fail' &&
    typeof window !== 'undefined' &&
    window.location.protocol === 'file:' &&
    isLocalHostBaseUrl(aiConfig.baseUrl);

  return (
    <Stack spacing={2.5} data-testid="settings-page">
      <Typography variant="h6" fontWeight={600}>
        设置
      </Typography>

      {/* 1. AI 配置 */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600}>
              AI 服务配置
            </Typography>
            <Chip
              size="small"
              data-testid="settings-mode-chip"
              color={mode === 'ai' ? 'primary' : 'default'}
              variant={mode === 'ai' ? 'filled' : 'outlined'}
              label={mode === 'ai' ? 'AI 模式' : '离线模式'}
            />
            {probing ? <Chip size="small" label="探测中…" /> : null}
          </Stack>

          <Stack spacing={2} maxWidth={560}>
            <TextField
              label="Base URL"
              size="small"
              placeholder="https://api.deepseek.com/v1"
              value={aiConfig.baseUrl}
              onChange={(e) => setAiConfig({ baseUrl: e.target.value })}
              inputProps={{ 'aria-label': 'Base URL' }}
            />
            <TextField
              label="API Key"
              size="small"
              type="password"
              placeholder="sk-..."
              value={aiConfig.apiKey}
              onChange={(e) => setAiConfig({ apiKey: e.target.value })}
              inputProps={{ 'aria-label': 'API Key' }}
              helperText="兼容 DeepSeek / 通义 / OpenAI / Ollama（Ollama 可留空）"
            />
            <Typography
              variant="caption"
              color="text.secondary"
              data-testid="api-key-persistence-hint"
              sx={{ mt: -1.5 }}
            >
              API 密钥以<b>明文</b>仅保存在本机浏览器（localStorage），不会上传到任何服务器；
              配置修改后<b>自动保存</b>，下次打开自动载入；更换设备需重新填写。
            </Typography>
            <TextField
              label="模型名"
              size="small"
              placeholder="deepseek-chat"
              value={aiConfig.model}
              onChange={(e) => setAiConfig({ model: e.target.value })}
              inputProps={{ 'aria-label': '模型名' }}
            />
            <TextField
              label="最大输出 tokens"
              size="small"
              type="number"
              value={aiConfig.maxTokens}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isInteger(parsed) && parsed >= MIN_MAX_TOKENS) {
                  setAiConfig({ maxTokens: parsed });
                }
              }}
              inputProps={{
                'aria-label': '最大输出 tokens',
                min: MIN_MAX_TOKENS,
                step: 1,
              }}
              helperText="推理模型思考也占配额，可按需调大（不设上限）；留空或非法值回落 4096。"
            />

            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={aiConfig.disableThinking}
                  onChange={(e) => setAiConfig({ disableThinking: e.target.checked })}
                  inputProps={{ 'aria-label': '关闭模型思考' }}
                />
              }
              label="关闭模型思考（推荐：让推理模型直接输出正文，更省配额、更快）"
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
              开启后请求会带 reasoning_effort:"none"（兼容端点）；服务端若不识别该字段会自动去掉重试一次，
              普通模型不受影响。若正文仍被截断，请确认服务端上下文足够（本机 Ollama 建议设
              OLLAMA_CONTEXT_LENGTH=16384）。
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={aiConfig.allowRawData}
                  onChange={(e) => setAiConfig({ allowRawData: e.target.checked })}
                  inputProps={{ 'aria-label': '允许发送原始数据' }}
                />
              }
              label="允许发送原始数据（默认关闭，仅发送统计摘要）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={() => void handleTest()} disabled={probing}>
                连通性测试
              </Button>
              <Button variant="outlined" onClick={() => void retry()} disabled={probing}>
                重试
              </Button>
              <Button
                color="inherit"
                onClick={() => {
                  applyProbeResult({
                    mode: 'offline',
                    reason: 'NOT_CONFIGURED',
                    keepConfig: true,
                    message: '已保留配置。',
                  });
                  setTestResult('idle');
                }}
              >
                清除测试结果
              </Button>
            </Stack>

            {testResult === 'ok' ? (
              <Alert severity="success" data-testid="settings-test-ok">
                连通性测试通过，已切换为 AI 模式。
              </Alert>
            ) : null}
            {testResult === 'fail' ? (
              <Alert severity="warning" data-testid="settings-test-fail">
                AI 服务暂不可用，已降级为离线模式（配置已保留）。原因：{reason || 'UNREACHABLE'}
                {showLocalFileHint ? (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    当前是双击打开的离线版，浏览器跨源策略禁止它直连本机 AI 服务。解决办法二选一：
                    ① 设置环境变量 OLLAMA_ORIGINS=* 后重启 Ollama；② 用 start.bat 通过本地服务打开。
                  </Typography>
                ) : null}
              </Alert>
            ) : null}
            {testResult === 'idle' && mode === 'offline' && reason ? (
              <Alert severity="info">当前为离线模式：{message}</Alert>
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      {/* 2. 判异准则默认开关 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
            判异准则默认开关
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, gap: 1 }}>
            {ALL_RULE_IDS.map((ruleId) => {
              const meta = RULE_META[ruleId];
              const enabled =
                meta.group === 'westernElectric'
                  ? toggles.westernElectric[ruleId as keyof typeof toggles.westernElectric]
                  : toggles.nelson[ruleId as keyof typeof toggles.nelson];
              const equivalent = EQUIVALENT_RULE[ruleId];
              return (
                <FormControlLabel
                  key={ruleId}
                  control={
                    <Switch
                      size="small"
                      checked={Boolean(enabled)}
                      onChange={(e) => setRule(ruleId, e.target.checked)}
                      inputProps={{ 'aria-label': `${ruleId} ${meta.shortName}` }}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      {ruleId} {meta.shortName}
                      {equivalent ? (
                        <Typography component="span" variant="caption" color="text.disabled">
                          {' '}
                          （等效 {equivalent}）
                        </Typography>
                      ) : null}
                    </Typography>
                  }
                />
              );
            })}
          </Box>
          <Typography variant="caption" color="text.secondary">
            默认启用西方电气 4 条与尼尔森 N5/N6/N7/N8；N1..N4 与 W 系列等价，默认关闭以避免重复告警。
          </Typography>
        </CardContent>
      </Card>

      {/* 3. 常数表 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
            控制限常数表（n = {MIN_SUBGROUP_N}..{MAX_SUBGROUP_N}）
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            出处：AIAG SPC 手册第 4 版 Appendix E / ASTM E2587。n 超出范围严禁外插；
            D3（n≤6）与 B3（n≤5）无定义，以「—」表示（不用 0 冒充）。
          </Typography>
          <TableContainer sx={{ maxHeight: 420 }}>
            <Table size="small" stickyHeader data-testid="constants-table">
              <TableHead>
                <TableRow>
                  {['n', 'A2', 'A3', 'D3', 'D4', 'B3', 'B4', 'd2', 'E2', 'c4'].map((h) => (
                    <TableCell key={h} align={h === 'n' ? 'left' : 'right'} sx={{ fontWeight: 600 }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {constants.map((row) => (
                  <TableRow key={row.n} hover>
                    <TableCell component="th" scope="row">
                      {row.n}
                    </TableCell>
                    <TableCell align="right">{row.A2}</TableCell>
                    <TableCell align="right">{row.A3}</TableCell>
                    <TableCell align="right" data-testid={`D3-${row.n}`}>
                      {cell(row.D3)}
                    </TableCell>
                    <TableCell align="right">{row.D4}</TableCell>
                    <TableCell align="right" data-testid={`B3-${row.n}`}>
                      {cell(row.B3)}
                    </TableCell>
                    <TableCell align="right">{row.B4}</TableCell>
                    <TableCell align="right">{row.d2}</TableCell>
                    <TableCell align="right">{row.E2}</TableCell>
                    <TableCell align="right">{row.c4}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      {/* 4. 数据与隐私说明 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
            数据与隐私说明
          </Typography>
          <Stack spacing={0.5}>
            <Typography variant="body2">
              • 离线模式下，所有数据仅存放于本机 IndexedDB/OPFS，<b>无任何外部网络请求</b>。
            </Typography>
            <Typography variant="body2">
              • AI 请求默认只发送<b>统计摘要</b>（均值 / 标准差 / 指数 / 违规列表），
              不含逐条原始测量值。
            </Typography>
            <Typography variant="body2">
              • 如需发送原始明细，须显式开启开关并在每次请求时<b>二次确认</b>。
            </Typography>
            <Typography variant="body2">
              • 每次 AI 请求都会写入使用审计（见下方），记录发送的数据范围。
            </Typography>
            <Typography
              variant="caption"
              color="text.disabled"
              display="block"
              sx={{ mt: 1 }}
              data-testid="app-build-stamp"
            >
              构建：{buildStamp()}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {/* 5. AI 使用审计 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
            AI 使用审计
          </Typography>
          {usageLogs.length === 0 ? (
            <Typography variant="body2" color="text.secondary" data-testid="usage-log-empty">
              暂无 AI 请求记录。
            </Typography>
          ) : (
            <Table size="small" data-testid="usage-log-table">
              <TableHead>
                <TableRow>
                  <TableCell>功能</TableCell>
                  <TableCell>发送范围</TableCell>
                  <TableCell>模型</TableCell>
                  <TableCell>时间</TableCell>
                  <TableCell>结果</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {usageLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>{USAGE_FEATURE_LABEL[log.feature]}</TableCell>
                    <TableCell>{USAGE_SCOPE_LABEL[log.sentPayloadScope]}</TableCell>
                    <TableCell>{log.model || '—'}</TableCell>
                    <TableCell>{log.requestedAt}</TableCell>
                    <TableCell>{log.ok ? '成功' : '失败'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 6. 项目库入口 */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1" fontWeight={600}>
                项目库管理
              </Typography>
              <Typography variant="body2" color="text.secondary">
                搜索 / 重命名 / 删除 / 复制项目。
              </Typography>
            </Box>
            <Button variant="outlined" onClick={() => navigate('/library')}>
              前往项目库
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
