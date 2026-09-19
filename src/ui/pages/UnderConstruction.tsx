/**
 * UnderConstruction —— 未实现模块的占位页。
 *
 * 出处：T03 要求「控制图/报表/AI/设置留占位路由，点击显示该模块开发中，不报错」。
 */

import { Box, Typography } from '@mui/material';
import { Construction as ConstructionIcon } from '@mui/icons-material';
import type { ReactElement } from 'react';

export interface UnderConstructionProps {
  /** 模块名称。 */
  moduleName: string;
  /** 交付阶段说明。 */
  plannedStage: string;
}

/**
 * 渲染「开发中」占位。
 *
 * @param props 组件属性
 * @returns 占位元素
 */
export default function UnderConstruction({
  moduleName,
  plannedStage,
}: UnderConstructionProps): ReactElement {
  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
      <ConstructionIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
      <Typography variant="h6">「{moduleName}」模块开发中</Typography>
      <Typography variant="body2" color="text.secondary">
        该模块计划于 {plannedStage} 交付，敬请期待。
      </Typography>
    </Box>
  );
}
