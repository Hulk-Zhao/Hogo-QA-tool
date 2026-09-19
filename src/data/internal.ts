/**
 * data 层内部工具：ID 生成与时间戳。
 *
 * 说明：不使用 crypto.randomUUID 的硬绑定，以便在无 Web Crypto 的
 * 测试环境（Node 老版本）下也能生成稳定可用的 id。优先使用
 * globalThis.crypto.randomUUID（Node 19+/现代浏览器均有），
 * 否则退化为「时间戳 + 计数器 + 随机串」的组合，保证进程内唯一。
 */

let counter = 0;

/** 生成一个进程内唯一的字符串 id。 */
export function genId(prefix = 'id'): string {
  counter += 1;
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && uuid.length > 0) {
    return `${prefix}_${uuid}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}

/** 当前时间：ISO 8601 UTC 字符串（架构 §8.5）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
