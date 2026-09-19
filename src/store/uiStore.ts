/**
 * uiStore —— 导航、加载态、Toast、当前弹窗。
 *
 * 出处：架构文档 §5（store 切分）。本 store **不持久化**。
 */

import { create } from 'zustand';

/** Toast 严重级别。 */
export type ToastSeverity = 'success' | 'info' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  message: string;
  severity: ToastSeverity;
}

interface UiState {
  /** 侧栏是否折叠。 */
  sidebarCollapsed: boolean;
  /** 全局加载中标记（>0 表示有进行中的异步任务）。 */
  loadingCount: number;
  /** 待展示的 Toast 队列。 */
  toasts: ToastMessage[];
  /** 当前打开的弹窗 id（null 表示无）。 */
  activeDialogId: string | null;

  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  beginLoading: () => void;
  endLoading: () => void;
  pushToast: (message: string, severity?: ToastSeverity) => void;
  dismissToast: (id: string) => void;
  openDialog: (id: string) => void;
  closeDialog: () => void;
}

let toastSeq = 0;

/** 生成 Toast 的唯一 id。 */
function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  loadingCount: 0,
  toasts: [],
  activeDialogId: null,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  beginLoading: () => set((s) => ({ loadingCount: s.loadingCount + 1 })),
  endLoading: () => set((s) => ({ loadingCount: Math.max(0, s.loadingCount - 1) })),
  pushToast: (message, severity = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToastId(), message, severity }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (id) => set({ activeDialogId: id }),
  closeDialog: () => set({ activeDialogId: null }),
}));
