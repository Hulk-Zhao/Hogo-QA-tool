import { createTheme } from '@mui/material/styles';

/**
 * MUI 主题。
 *
 * 与 `tailwind.config.ts` 中的颜色 token 对齐（brand / violation）。
 * 所有图表颜色也都引用此处的 token，避免硬编码色值
 * （唯一例外：违规高亮红 #E74C3C，由主题变量提供）。
 */
export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#4472C4',
      dark: '#2c4d85',
      light: '#e8f0fe',
      contrastText: '#ffffff',
    },
    error: {
      main: '#E74C3C',
    },
    warning: {
      main: '#F39C12',
    },
    background: {
      default: '#f5f7fa',
      paper: '#ffffff',
    },
    text: {
      primary: '#1f2329',
      secondary: '#5f6672',
      disabled: '#a3a9b3',
    },
  },
  typography: {
    fontFamily: [
      'Microsoft YaHei',
      'PingFang SC',
      'Hiragino Sans GB',
      'Segoe UI',
      'system-ui',
      'sans-serif',
    ].join(','),
  },
  shape: {
    borderRadius: 6,
  },
});

/** 图表与违规高亮共用的颜色 token（供 UI 层引用，避免散落色值）。 */
export const chartThemeTokens = {
  bar: '#4472C4',
  line: '#E74C3C',
  hline: '#E74C3C',
  violationHigh: '#E74C3C',
  violationMedium: '#F39C12',
  violationLow: '#F1C40F',
  zoneBandA: 'rgba(231, 76, 60, 0.08)',
  zoneBandB: 'rgba(243, 156, 18, 0.06)',
} as const;

export default theme;
