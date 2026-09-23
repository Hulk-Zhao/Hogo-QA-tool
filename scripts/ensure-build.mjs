/**
 * ensure-build.mjs —— 保证 `dist-server/` 是**当前源码**构建出来的。
 *
 * 为什么需要它（2026-09-23 真实踩坑）：
 * `start.bat` 原先只在 `dist-server\index.html` **不存在**时才构建。一旦它存在，
 * 之后任何源码改动都不会进到用户打开的页面里 —— 表现为「明明修好了，start.bat
 * 重启后还是老样子」，而且界面上没有任何提示，用户只会得出「修复无效」的结论。
 *
 * 本轮实测证据：P0 修复已进 `dist/`（离线包），但 start.bat 服务的是前一天构建的
 * `dist-server/assets/index-DdTqtvMx.js`，里面仍是旧文案 —— 于是用户报「导入仍然失败」。
 * 项目里已有 `__BUILD_STAMP__`（见 `src/ui/buildStamp.ts`）用于事后比对版本，
 * 但那只解决「怎么排查」，本脚本解决「根本不让你跑到旧产物」。
 *
 * 判定口径：`dist-server/index.html` 缺失，或**任一构建输入**比它新 → 过期 → 构建。
 * 宁可多构建一次（约 25 秒），也不能让用户默默跑旧代码。
 *
 * 用法：
 *   node scripts/ensure-build.mjs           # 过期才构建
 *   node scripts/ensure-build.mjs --check   # 只检查不构建：过期 exit 1，新鲜 exit 0
 *   node scripts/ensure-build.mjs --force   # 无条件构建
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件在 scripts/ 下）。 */
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 构建产物入口（存在即认为构建过）。 */
export const TARGET = join(ROOT, 'dist-server', 'index.html');

/**
 * 构建输入：任一文件比产物新即视为过期。
 *
 * 刻意**不含** `node_modules` 与 `dist*`（前者噪声大，后者是产物）。
 * 列的是真正会改变产物内容的东西：源码、入口 HTML、依赖清单、构建配置、本地环境变量。
 */
export const BUILD_INPUTS = [
  'src',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'vite.config.offline.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'tailwind.config.js',
  'tailwind.config.cjs',
  'postcss.config.js',
  'postcss.config.cjs',
  '.env',
];

/**
 * 递归收集一个路径下所有文件的修改时间（毫秒）。文件不存在时返回空数组。
 *
 * @param {string} abs 绝对路径（文件或目录）
 * @returns {number[]} 各文件 mtime（毫秒）
 */
export function collectMtimes(abs) {
  if (!existsSync(abs)) {
    return [];
  }
  const info = statSync(abs);
  if (info.isFile()) {
    return [info.mtimeMs];
  }
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMtimes(child));
    } else if (entry.isFile()) {
      out.push(statSync(child).mtimeMs);
    }
  }
  return out;
}

/**
 * 纯函数：判定构建产物是否过期。
 *
 * 抽成纯函数是为了让判定口径能被独立验证（本仓库对「不可验证的接线」零容忍）。
 *
 * @param {number | null} targetMtime 产物 mtime（毫秒）；null 表示产物不存在
 * @param {number[]} inputMtimes 各构建输入文件的 mtime（毫秒）
 * @returns {boolean} true = 需要重新构建
 */
export function isStale(targetMtime, inputMtimes) {
  if (targetMtime === null) {
    return true;
  }
  return inputMtimes.some((t) => t > targetMtime);
}

/** 收集全部构建输入的 mtime。 */
export function collectInputMtimes() {
  const out = [];
  for (const rel of BUILD_INPUTS) {
    out.push(...collectMtimes(join(ROOT, rel)));
  }
  return out;
}

/** 产物 mtime（不存在返回 null）。 */
export function targetMtime() {
  return existsSync(TARGET) ? statSync(TARGET).mtimeMs : null;
}

/** 真正执行构建（与原先 start.bat 的行为一致：vite build，产物 dist-server/）。 */
function runBuild() {
  console.log('  正在构建 dist-server（源码比产物新）…');
  const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error('  [ERROR] 构建失败（exit ' + String(r.status) + '）。请手动运行 npx vite build 查看详情。');
    return false;
  }
  if (!existsSync(TARGET)) {
    console.error('  [ERROR] 构建结束但没有产出 ' + TARGET + '。');
    return false;
  }
  console.log('  构建完成。');
  return true;
}

/* CLI 入口（被 import 时不执行）。 */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const stale = force || isStale(targetMtime(), collectInputMtimes());

  if (!stale) {
    console.log('  dist-server 已是最新（无需构建）。');
  } else if (checkOnly) {
    console.log('  dist-server 已过期：需要对源码重新构建（node scripts/ensure-build.mjs）。');
    process.exit(1);
  } else if (!runBuild()) {
    process.exit(1);
  }
}