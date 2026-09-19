// @vitest-environment jsdom
/**
 * ToastHost 测试（P3-E）。
 *
 * 缺陷背景（实测）：`uiStore.pushToast` 有 20+ 个调用点，却没有组件渲染
 * `toasts`，于是「已导出 Excel」「请至少勾选一项」这类提示从来没显示过。
 *
 * 证伪立场：把 AppShell 里的 <ToastHost /> 删掉 / 让它在空队列时也返回元素 /
 * 关掉后不出队 → 对应用例变红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render } from '@testing-library/react';
import ToastHost, { TOAST_AUTO_HIDE_MS } from '@/ui/components/ToastHost';
import { useUiStore } from '@/store/uiStore';

describe('ToastHost', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  it('空队列 → 不渲染任何提示', () => {
    render(<ToastHost />);
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('pushToast 后真的渲染出提示文本与严重级别', () => {
    render(<ToastHost />);
    act(() => {
      useUiStore.getState().pushToast('已导出 Excel：a.xlsx（内嵌 2 张图）', 'success');
    });
    const toast = screen.getByTestId('toast');
    expect(toast.textContent).toContain('已导出 Excel');
    expect(toast.getAttribute('data-toast-severity')).toBe('success');
  });

  it('队列按先进先出逐条展示，关闭后自动出队显示下一条', () => {
    render(<ToastHost />);
    act(() => {
      useUiStore.getState().pushToast('第一条', 'info');
      useUiStore.getState().pushToast('第二条', 'warning');
    });
    expect(screen.getByTestId('toast').textContent).toContain('第一条');
    expect(useUiStore.getState().toasts).toHaveLength(2);

    // 点关闭按钮 → 出队 → 立即显示第二条
    const closeBtn = screen.getByTestId('toast').querySelector('button');
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(screen.getByTestId('toast').textContent).toContain('第二条');
    expect(useUiStore.getState().toasts).toHaveLength(1);
  });

  it('提示会自动消失（autoHideDuration 生效）', () => {
    expect(TOAST_AUTO_HIDE_MS).toBeGreaterThan(1000);
    expect(TOAST_AUTO_HIDE_MS).toBeLessThanOrEqual(10000);
  });
});
