/**
 * createRepository / createRepositoryAsync：按运行时能力创建合适的 ProjectRepository。
 *
 * 出处：架构文档 §0.1、§7.4。
 * 后端优先级（降级链）：
 *   1. IndexedDB 可用        → IdbRepository（可选注入 OPFS FileStore，完整持久化）。
 *   2. IndexedDB 不可用但 localStorage 可用 → IdbRepository + LocalStorageKeyValueStore
 *      （best-effort 持久化；典型场景：`file://` 双击离线模式）。
 *   3. 两者皆不可用           → MemoryRepository（仅会话内有效，UI 提示导出 JSON）。
 *
 * 能力探测分两档：
 * - `createRepository`（同步，保守）：使用 `probe`，适合测试注入与快速判定。
 * - `createRepositoryAsync`（推荐，真实）：使用异步真实探测，真正 `open()` IndexedDB
 *   并带超时，消除 `file://` 下「符号存在但 open 挂起」的假阳性。
 *
 * 为可测试性，各探测函数与适配器工厂均可注入；默认实现触碰浏览器 API。
 */

import type { FileStore, KeyValueStore, StorageCapabilities } from '../storage/adapters';
import {
  IdbKeyValueStore,
  LocalStorageKeyValueStore,
  OpfsFileStore,
  probeFileStore,
  probeKeyValueStore,
  probeKeyValueStoreAsync,
  probeLocalStorageKeyValueStore,
} from '../storage/browserAdapters';
import { MemoryFileStore, MemoryKeyValueStore } from '../storage/memoryAdapters';
import { IdbRepository } from './idbRepository';
import { MemoryRepository } from './memoryRepository';
import type { ProjectRepository } from './types';

/** 实际使用的持久化后端。 */
export type StorageBackend = 'indexeddb' | 'localstorage' | 'memory';

/** 依赖注入点（测试可覆盖，避免触碰浏览器 API）。 */
export interface RepositoryFactoryDeps {
  /** 同步能力探测函数。 */
  probe: () => StorageCapabilities;
  /** 异步真实能力探测（可选；缺省时回退到 `probe`）。 */
  probeAsync?: () => Promise<StorageCapabilities>;
  /** 创建 IndexedDB 键值仓库。 */
  createKeyValue: () => KeyValueStore;
  /** 创建文件仓库（OPFS 不可用时返回 null）。 */
  createFileStore: () => FileStore | null;
  /** localStorage 能力探测（可选；缺省视为不可用）。 */
  probeLocalStorage?: () => boolean;
  /** 创建 localStorage 键值仓库（可选）。 */
  createLocalStorageKeyValue?: () => KeyValueStore;
}

/** 默认同步探测：真实浏览器环境。 */
export function defaultProbe(): StorageCapabilities {
  return {
    hasKeyValue: probeKeyValueStore(),
    hasFileStore: probeFileStore(),
  };
}

/** 默认异步真实探测：真正 `open()` IndexedDB 并带超时。 */
export async function defaultProbeAsync(): Promise<StorageCapabilities> {
  const hasKeyValue = await probeKeyValueStoreAsync();
  return { hasKeyValue, hasFileStore: probeFileStore() };
}

/** 默认工厂：真实浏览器适配器。 */
export function defaultDeps(): RepositoryFactoryDeps {
  return {
    probe: defaultProbe,
    probeAsync: defaultProbeAsync,
    createKeyValue: () => new IdbKeyValueStore(),
    createFileStore: () => (probeFileStore() ? new OpfsFileStore() : null),
    probeLocalStorage: probeLocalStorageKeyValueStore,
    createLocalStorageKeyValue: () => new LocalStorageKeyValueStore(),
  };
}

/** 工厂结果：附能力信息，供 UI 决定是否提示降级。 */
export interface RepositoryHandle {
  repository: ProjectRepository;
  capabilities: StorageCapabilities;
  /** true 表示**未使用首选 IndexedDB 后端**（已降级为 localStorage 或内存）。 */
  degraded: boolean;
  /** 实际使用的持久化后端。 */
  backend: StorageBackend;
  /** 是否具备跨会话持久化能力（memory 为 false）。 */
  persistent: boolean;
}

/**
 * 依据能力探测结果选择后端并构造仓库句柄。
 *
 * @param capabilities 能力探测结果
 * @param deps 依赖注入
 * @returns 仓库句柄
 */
function buildHandle(
  capabilities: StorageCapabilities,
  deps: RepositoryFactoryDeps,
): RepositoryHandle {
  if (capabilities.hasKeyValue) {
    const keyValue = deps.createKeyValue();
    const fileStore = capabilities.hasFileStore ? deps.createFileStore() : null;
    const repository = new IdbRepository(fileStore ? { keyValue, fileStore } : { keyValue });
    return { repository, capabilities, degraded: false, backend: 'indexeddb', persistent: true };
  }
  if (deps.probeLocalStorage?.() === true && typeof deps.createLocalStorageKeyValue === 'function') {
    const keyValue = deps.createLocalStorageKeyValue();
    // 无 OPFS 文件仓库：测量值内联进 localStorage（best-effort 持久化，可能触发配额限制）。
    const repository = new IdbRepository({ keyValue });
    return { repository, capabilities, degraded: true, backend: 'localstorage', persistent: true };
  }
  return {
    repository: new MemoryRepository(),
    capabilities,
    degraded: true,
    backend: 'memory',
    persistent: false,
  };
}

/**
 * 同步创建仓库（保守探测；默认走浏览器实现）。
 *
 * @param deps 依赖注入（默认走浏览器实现；测试注入内存实现）
 */
export function createRepository(deps: RepositoryFactoryDeps = defaultDeps()): RepositoryHandle {
  return buildHandle(deps.probe(), deps);
}

/**
 * 异步创建仓库（**推荐**）：先做真实能力探测，再选择后端。
 *
 * 相比同步版，可识别「IndexedDB 符号存在但 `open()` 会挂起/失败」的场景
 * （典型：`file://` 双击离线模式），从而正确降级到 localStorage / 内存，
 * 避免保存时挂起。
 *
 * @param deps 依赖注入（默认走浏览器真实探测）
 * @returns 仓库句柄
 */
export async function createRepositoryAsync(
  deps: RepositoryFactoryDeps = defaultDeps(),
): Promise<RepositoryHandle> {
  const capabilities = await (deps.probeAsync ?? (() => Promise.resolve(deps.probe())))();
  return buildHandle(capabilities, deps);
}

/**
 * 生成面向用户的降级说明（供 UI 展示；完整 IDB 后端返回空串）。
 *
 * @param handle 仓库句柄
 * @returns 提示文案；无降级时为空字符串
 */
export function degradationHint(handle: RepositoryHandle): string {
  if (handle.backend === 'memory') {
    return (
      '当前为离线双击模式，本地存储不可用，项目仅在本会话内有效、不会保存。' +
      '如需保存项目，请用 start.bat 通过本地服务打开。'
    );
  }
  if (handle.backend === 'localstorage') {
    return (
      '当前为离线双击模式，IndexedDB 不可用，项目无法可靠持久化保存' +
      '（仅暂存于浏览器本地，容量有限且可能被清理）。' +
      '如需稳定保存，请用 start.bat 通过本地服务打开。'
    );
  }
  return '';
}

/** 测试辅助：构造一个纯内存的依赖包，不触碰任何浏览器 API。 */
export function memoryDeps(): RepositoryFactoryDeps {
  const kv = new MemoryKeyValueStore();
  const fs = new MemoryFileStore();
  return {
    probe: () => ({ hasKeyValue: true, hasFileStore: true }),
    createKeyValue: () => kv,
    createFileStore: () => fs,
  };
}
