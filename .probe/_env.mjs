/**
 * 探针共用的本机依赖定位。
 *
 * 为什么需要它：这些脚本原先写死了作者本机的 Chrome 与 Python 路径，
 * 换台机器（或开源给他人）就跑不起来。这里改成「环境变量优先 → 各平台常见位置逐个探测 → PATH」。
 *
 * 可用环境变量覆盖：
 *   CHROME_PATH  指定 Chrome/Chromium 可执行文件
 *   PYTHON_PATH  指定 Python（用于第三方视角核对 Word/Excel 产物）
 */

import fs from 'node:fs';

/** 候选 Chrome 路径（按顺序取第一个真实存在的）。 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe'
    : '',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => typeof p === 'string' && p.length > 0);

/** Chrome/Chromium 可执行文件；都找不到时退回 'chrome'（交给 PATH 解析）。 */
export const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || 'chrome';

/** Chrome 的实际来源（打印出来便于排查）。 */
export const CHROME_SOURCE =
  process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)
    ? 'CHROME_PATH'
    : CHROME_CANDIDATES.includes(CHROME)
      ? '自动探测'
      : 'PATH';

/** Python 可执行文件（第三方核对脚本用）。 */
export const PYTHON = process.env.PYTHON_PATH || 'python';