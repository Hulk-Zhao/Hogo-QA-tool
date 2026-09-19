/**
 * handle —— 仓库句柄的**会话级单例**（全应用共享一个 `ProjectRepository`）。
 *
 * 为什么需要单独一个模块（本轮 P1 架构收敛）：
 * 此前 `useProjectPersistence`（能力分析页保存）与 `ProjectLibraryPage`
 * （项目库）**各自**持有一份 `createRepositoryAsync()` 的单例 promise，
 * 而本轮新增的「启动自动恢复上次项目」需要第三个调用点。三份各自为政的单例
 * 意味着：
 *   1. 真实能力探测（真正 `open()` IndexedDB）会被执行三次；
 *   2. 若两次探测结果不一致（例如一次超时失败、一次成功），会同时存在
 *      IndexedDB 与 localStorage 两个后端，出现「保存到 A、读取走 B」的
 *      静默数据丢失 —— 这是本项目最不能接受的一类缺陷。
 *
 * 因此把句柄收敛为**唯一来源**：所有需要仓库的 UI（项目库 / 保存按钮 /
 * 启动恢复）都调用 `getSharedRepositoryHandle()`，后端选择在会话内恒定。
 *
 * 分层说明：本文件属数据层的「组合入口」，只依赖同层的 `./index`，
 * 不触碰任何 DOM / store / 页面逻辑。
 */

import { createRepositoryAsync, type RepositoryHandle } from './index';

/** 进程内单例 promise（探测只做一次，失败结果同样被缓存以保持后端一致）。 */
let handlePromise: Promise<RepositoryHandle> | null = null;

/**
 * 取得（并懒创建）全应用共享的仓库句柄。
 *
 * @returns 仓库句柄 promise（同一会话内始终是同一个后端）
 */
export function getSharedRepositoryHandle(): Promise<RepositoryHandle> {
  if (handlePromise === null) {
    handlePromise = createRepositoryAsync();
  }
  return handlePromise;
}

/**
 * 重置单例（**仅供测试**使用，模拟一次冷启动）。
 *
 * @returns void
 */
export function resetSharedRepositoryHandle(): void {
  handlePromise = null;
}
