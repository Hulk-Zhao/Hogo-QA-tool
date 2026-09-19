/**
 * AiGate —— AI 入口统一门控。
 *
 * 出处：架构文档 §7.2。`mode === 'offline'` 时禁用子入口并提示，
 * **不渲染空面板**（直接禁用按钮并给出 tooltip）。
 *
 * T05 增强（保持既有行为兼容）：
 * - 新增可选 `hideWhenOffline`：离线时直接隐藏子元素（用于「AI 解读」等按钮）；
 * - tooltip 文案优先展示 settingsStore.modeReason（含探测失败原因）。
 *
 * 本轮增强：
 * - 新增可选 `allowWhenOffline`：离线时仅保留 tooltip 提示、不禁用子元素，
 *   用于「AI 解读」这类**导航入口**（点击进入 AI 页查看离线引导，而非死按钮）。
 */

import { Tooltip } from '@mui/material';
import type { ReactElement, ReactNode } from 'react';
import { useSettingsStore } from '@/store/settingsStore';

export interface AiGateProps {
  children: ReactNode;
  /** 禁用时的提示文案。 */
  disabledHint?: string;
  /** 离线时是否直接隐藏（默认 false：置灰 + tooltip）。 */
  hideWhenOffline?: boolean;
  /**
   * 离线时是否仍允许交互（默认 false）。
   *
   * - false：保持既有语义 —— 包裹层置灰并标记 `aria-disabled`，子元素应自身 disabled；
   * - true：仅保留 tooltip 提示（如「配置 AI 服务后可用」），但不加 `aria-disabled` /
   *   `cursor: not-allowed`，子元素**保持可点击**。用于「AI 解读」这类**导航入口**：
   *   离线时点击应能跳转到 AI 助手页并展示离线引导，而非变成死按钮。
   */
  allowWhenOffline?: boolean;
}

/**
 * 门控 AI 相关入口。
 *
 * @param props 组件属性
 * @returns 门控后的元素
 */
export default function AiGate({
  children,
  disabledHint = '配置 AI 服务后可用',
  hideWhenOffline = false,
  allowWhenOffline = false,
}: AiGateProps): ReactElement {
  const mode = useSettingsStore((s) => s.mode);
  const reason = useSettingsStore((s) => s.modeReason);

  if (mode === 'ai') {
    return <>{children}</>;
  }

  if (hideWhenOffline) {
    return <></>;
  }

  return (
    <Tooltip title={reason || disabledHint}>
      {allowWhenOffline ? (
        // 仅提示，不禁用：保留离线说明语义，同时允许子元素（导航）继续工作。
        // 直接透传子元素（须为可接收 ref 的单元素，如 MUI Button）。
        (children as ReactElement)
      ) : (
        <span
          style={{ display: 'inline-flex', cursor: 'not-allowed' }}
          aria-disabled
          data-testid="ai-gate-disabled"
        >
          {children}
        </span>
      )}
    </Tooltip>
  );
}
