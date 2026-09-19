/**
 * ConfirmDialog —— 通用确认对话框。
 *
 * 用于破坏性或需二次确认的操作（如清空数据、确认排除异常值）。
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import type { ReactElement, ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  content: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: 'primary' | 'error' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 渲染确认对话框。
 *
 * @param props 组件属性
 * @returns 对话框元素
 */
export default function ConfirmDialog({
  open,
  title,
  content,
  confirmText = '确认',
  cancelText = '取消',
  confirmColor = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{content}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} color="inherit">
          {cancelText}
        </Button>
        <Button onClick={onConfirm} color={confirmColor} variant="contained">
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
