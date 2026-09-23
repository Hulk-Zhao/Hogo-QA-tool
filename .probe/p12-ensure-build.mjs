/**
 * p12-ensure-build —— start.bat 新增的「过期即重建」这一步的自检。
 *
 * 背景（2026-09-23 用户报障的根因）：start.bat 原先只在 dist-server\index.html
 * **不存在**时才构建，于是源码改了而旧产物还在时，用户会一直跑旧代码 ——
 * 表现为「明明修好了，start.bat 重启后导入仍然失败」。修复见
 * `scripts/ensure-build.mjs` + `start.bat`。
 *
 * 本脚本把那段判定按三层验证：
 *   1. 纯函数口径（isStale）—— 边界：产物缺失 / 输入更新 / 输入更旧；
 *   2. `--check` 的真实退出码 —— 触碰一个源码文件后必须变 1，重建后必须回 0；
 *   3. 真的会重建 —— 不带 --check 跑一次，dist-server\index.html 的 mtime 必须变大。
 *
 * 无副作用地「弄旧」产物：只改一个源文件的 mtime（内容不变），不动任何内容。
 */
import { spawnSync } from 'node:child_process';
import { statSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROOT, TARGET, collectInputMtimes, isStale, targetMtime } from '../scripts/ensure-build.mjs';

const checks = [];

/** 记录一条断言。 */
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
}

/** 跑 `node scripts/ensure-build.mjs [flags]`，返回 exit code。 */
function runCli(flags = []) {
  const r = spawnSync('node', [resolve(ROOT, 'scripts/ensure-build.mjs'), ...flags], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { code: r.status, stdout: (r.stdout || '').trim() };
}

// ---- 1. 纯函数口径 ----
check('isStale(null, ...) → true（产物缺失）', isStale(null, []) === true);
check('isStale(100, []) → false（无输入）', isStale(100, []) === false);
check('isStale(100, [99]) → false（输入更旧）', isStale(100, [99]) === false);
check('isStale(100, [101]) → true（输入更新）', isStale(100, [101]) === true);
check(
  'isStale(100, [1, 2, 101, 3]) → true（任一输入更新即过期）',
  isStale(100, [1, 2, 101, 3]) === true,
);

// ---- 2. 干净态：应当报「最新」 ----
const before = runCli(['--check']);
check('干净态 --check exit 0（当前产物是最新）', before.code === 0, before.stdout);

// ---- 3. 弄旧一个源文件 → --check 必须变 1 ----
const srcFile = resolve(ROOT, 'src/store/projectStore.ts');
const now = new Date();
utimesSync(srcFile, now, now); // 只改 mtime，内容零改动
const staleRun = runCli(['--check']);
check('源码变新后 --check exit 1（能被检出）', staleRun.code === 1, staleRun.stdout);

// ---- 4. 真的会重建：mtime 必须变大 ----
const targetBefore = statSync(TARGET).mtimeMs;
const rebuild = runCli([]);
const targetAfter = statSync(TARGET).mtimeMs;
check('不带 --check 时会真的重建（exit 0）', rebuild.code === 0, rebuild.stdout);
check('重建后 dist-server\\index.html 的 mtime 变大', targetAfter > targetBefore);

// ---- 5. 重建后回到「最新」 ----
const after = runCli(['--check']);
check('重建后 --check exit 0（回到最新）', after.code === 0, after.stdout);
check('重建后 targetMtime 晚于全部输入', isStale(targetMtime(), collectInputMtimes()) === false);

const ok = checks.every((c) => c.pass);
console.log(JSON.stringify({ ok, checks }, null, 2));
process.exitCode = ok ? 0 : 1;