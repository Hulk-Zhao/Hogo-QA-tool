/**
 * ModeBadge —— 离线 / AI 模式徽标。
 *
 * 出处：架构文档 §7.2；PRD §6.2。
 *
 * T05 增强：新增「探测中」状态（probeStatus==='probing'），
 * 探测失败时 tooltip 显示具体原因（来自 settingsStore.modeReason）。
 */

import { Chip, Tooltip } from '@mui/material';
import {
  CloudOff as CloudOffIcon,
  CloudDone as CloudDoneIcon,
  CloudSync as CloudSyncIcon,
} from '@mui/icons-material';
import type { ReactElement } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { useAiAvailability } from '@/ui/hooks/useAiAvailability';

/**
 * 渲染模式徽标。
 *
 * 说明：ModeBadge 常驻顶栏，故在此驱动一次启动探测（`useAiAvailability`），
 * 使 AI 可用性在应用启动时即被探测并降级（架构 §4.3）。未配置服务地址
 * （baseUrl 为空）时该 hook 不会发起任何网络请求（数据主权 G3）。
 *
 * @returns 徽标元素
 */
export default function ModeBadge(): ReactElement {
  // 启动探测：**必须真正调用** `useAiAvailability()`（挂载即探测、配置变更自动重探）。
  // 此前这里被写成 `void useAiAvailability;`（只为消「未使用导入」告警，从未调用），
  // 导致冷启动从不探测、徽标永远停在「离线模式」——`ModeBadge.spec` 以此为证伪点。
  const { mode, status } = useAiAvailability();
  const reason = useSettingsStore((s) => s.modeReason);
  const probing = status === 'probing';
  const isAi = mode === 'ai';

  if (probing) {
    return (
      <Tooltip title="正在探测 AI 服务可用性…">
        <Chip
          size="small"
          icon={<CloudSyncIcon />}
          label="探测中"
          color="default"
          variant="outlined"
          data-testid="mode-badge-probing"
          sx={{ fontWeight: 500 }}
        />
      </Tooltip>
    );
  }

  return (
    <Tooltip title={isAi ? 'AI 服务可用' : reason || '当前为离线模式，核心功能全部可用'}>
      <Chip
        size="small"
        icon={isAi ? <CloudDoneIcon /> : <CloudOffIcon />}
        label={isAi ? 'AI 模式' : '离线模式'}
        color={isAi ? 'primary' : 'default'}
        variant={isAi ? 'filled' : 'outlined'}
        data-testid="mode-badge"
        sx={{ fontWeight: 500 }}
      />
    </Tooltip>
  );
}
