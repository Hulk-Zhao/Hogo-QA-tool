/**
 * ToastHost —— 全局提示宿主（P3-E）。
 *
 * 缺陷背景（本轮实测发现）：`uiStore.pushToast` 被 20 多处调用
 * （导出成功/失败、无数据、导出范围为空…），但**没有任何组件渲染
 * `uiStore.toasts`** —— 也就是说这些提示在界面上从来没出现过。
 * 实测证据：点「导出 Excel」后 `document.body.innerText` 里搜不到
 * 「已导出 Excel」，而 store 里确实有一条 toast。
 *
 * 对用户的实际影响：点了导出却没有任何反馈，只能去下载目录里猜；
 * 导出失败（例如无数据）时也完全静默。
 *
 * 实现：一次只展示队列里最早的一条，关闭后自动出队，下一条接着显示。
 */

import { Alert, Snackbar } from '@mui/material';
import type { ReactElement } from 'react';
import { useUiStore } from '@/store/uiStore';

/** 提示自动消失时间（ms）。 */
export const TOAST_AUTO_HIDE_MS = 6000;

/**
 * 渲染全局提示。
 *
 * @returns 提示元素
 */
export default function ToastHost(): ReactElement | null {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const current = toasts[0];

  if (!current) {
    return null;
  }

  return (
    <Snackbar
      key={current.id}
      open
      autoHideDuration={TOAST_AUTO_HIDE_MS}
      onClose={() => dismissToast(current.id)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert
        severity={current.severity}
        variant="filled"
        onClose={() => dismissToast(current.id)}
        data-testid="toast"
        data-toast-severity={current.severity}
      >
        {current.message}
      </Alert>
    </Snackbar>
  );
}
