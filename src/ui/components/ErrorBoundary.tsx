/**
 * ErrorBoundary —— 页面级错误兜底。
 *
 * 出处：架构文档 §8.4「UI 层 ErrorBoundary 兜底页面级崩溃」。
 */

import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义降级渲染。 */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/**
 * React 错误边界组件。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false, message: '' };

  /**
   * 捕获子组件渲染错误。
   *
   * @param error 错误对象
   * @returns 更新后的状态
   */
  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message };
  }

  /**
   * 记录错误详情（此处仅保留控制台输出，不引入日志服务）。
   *
   * @param error 错误对象
   * @param info React 错误信息
   */
  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] 捕获到渲染错误:', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  /**
   * 渲染。
   *
   * @returns 子组件或降级 UI
   */
  public override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <Box sx={{ p: 4 }}>
          <Stack spacing={2} alignItems="flex-start">
            <Typography variant="h6" color="error.main">
              页面渲染出错
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {this.state.message || '发生了未预期的错误。'}
            </Typography>
            <Button variant="outlined" onClick={this.handleReset}>
              重试
            </Button>
          </Stack>
        </Box>
      );
    }
    return this.props.children;
  }
}

/**
 * 便捷函数式包装（仅供类型提示）。
 *
 * @param props 组件属性
 * @returns 错误边界元素
 */
export function withErrorBoundary(props: ErrorBoundaryProps): ReactElement {
  return <ErrorBoundary {...props} />;
}
