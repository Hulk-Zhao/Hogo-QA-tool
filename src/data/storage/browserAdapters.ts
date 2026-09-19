/**
 * browserAdapters：真实浏览器环境的存储适配器实现。
 *
 * 使用 `idb` 8（IndexedDB 的 Promise 封装）与 OPFS
 * （`navigator.storage.getDirectory()`）。本文件是**唯一**直接触碰
 * `indexedDB` / `navigator` 的地方；repositories 通过接口注入使用。
 *
 * 出处：架构文档 §7.4；team-lead T02「存储走依赖注入」。
 */

import { openDB, type IDBPDatabase } from 'idb';
import { HogoError } from '../errors';
import type { FileStore, JsonStore, KeyValueStore, StoreName } from './adapters';

/** IndexedDB 数据库名与版本。 */
export const IDB_NAME = 'hogo-qa-tool';
export const IDB_VERSION = 1;

interface ProjectDbSchema {
  projects: { key: string; value: unknown };
  measurements: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<ProjectDbSchema>> | null = null;

/**
 * 打开（并缓存）IndexedDB 连接。
 *
 * @throws {Error} 环境不支持 IndexedDB 时由 idb 抛错，调用方据能力探测先行拦截。
 */
function getDb(): Promise<IDBPDatabase<ProjectDbSchema>> {
  if (dbPromise === null) {
    dbPromise = openDB<ProjectDbSchema>(IDB_NAME, IDB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects');
        }
        if (!db.objectStoreNames.contains('measurements')) {
          db.createObjectStore('measurements');
        }
      },
    });
  }
  return dbPromise;
}

/** 浏览器 IndexedDB 键值仓库。 */
export class IdbKeyValueStore implements KeyValueStore {
  async getAll<T>(store: StoreName): Promise<T[]> {
    const db = await getDb();
    const values = await db.getAll(store);
    return values as T[];
  }

  async get<T>(store: StoreName, key: string): Promise<T | null> {
    const db = await getDb();
    const value = await db.get(store, key);
    return (value as T | undefined) ?? null;
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    const db = await getDb();
    await db.put(store, value, key);
  }

  async delete(store: StoreName, key: string): Promise<void> {
    const db = await getDb();
    await db.delete(store, key);
  }
}

/** 浏览器 OPFS 文本文件仓库。 */
export class OpfsFileStore implements FileStore {
  /** 获取（并按需创建）OPFS 根目录句柄（类型由 navigator.storage 推导）。 */
  private async root(): Promise<Awaited<ReturnType<typeof navigator.storage.getDirectory>>> {
    return navigator.storage.getDirectory();
  }

  async writeText(fileName: string, content: string): Promise<void> {
    const root = await this.root();
    const handle = await root.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async readText(fileName: string): Promise<string | null> {
    const root = await this.root();
    try {
      const handle = await root.getFileHandle(fileName);
      const file = await handle.getFile();
      return file.text();
    } catch {
      return null;
    }
  }

  async delete(fileName: string): Promise<void> {
    const root = await this.root();
    try {
      await root.removeEntry(fileName);
    } catch {
      // 不存在时静默返回（幂等删除语义）。
    }
  }

  async exists(fileName: string): Promise<boolean> {
    const root = await this.root();
    try {
      await root.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }
}

/** IndexedDB 探测专用数据库名（与业务库隔离，避免污染真实 schema）。 */
const PROBE_DB_NAME = `${IDB_NAME}__probe__`;

/**
 * 能力探测（同步，保守）：当前环境是否**具备** IndexedDB 键值存储。
 *
 * 仅做「符号存在 + 非 file://」判定：
 * - 符号不存在（旧环境）→ 不可用；
 * - `file://`（不透明源 origin=null）→ Chrome 会阻止 IndexedDB：`open()`
 *   既不触发 onsuccess 也不触发 onerror，直到超时，因此这里直接判为不可用，
 *   消除「符号存在即可用」的**假阳性**。
 *
 * 需要**真实**可用性（例如「符号存在但 open 会失败」的其它场景）请用
 * `probeKeyValueStoreAsync`。
 */
export function probeKeyValueStore(): boolean {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return false;
  }
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    return false;
  }
  return true;
}

/**
 * 能力探测（异步，真实）：尝试 `open()` 一个探测用 IndexedDB，并带超时。
 *
 * 仅当 `open()` 在 `timeoutMs` 内成功回调才返回 true；超时 / 报错 /
 * 被阻止（onblocked）均返回 false。用于识别「符号存在但实际不可用」
 * 的场景（典型：`file://` 下 Chrome 阻止 IndexedDB，`open()` 挂起）。
 *
 * @param timeoutMs 超时毫秒数（默认 1500）
 * @returns 探测期间是否会成功打开 IndexedDB
 */
export function probeKeyValueStoreAsync(timeoutMs = 1500): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, db: IDBDatabase | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (db !== null) {
        try {
          db.close();
        } catch {
          // 关闭探测库异常可忽略，不影响探测结论。
        }
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false, null), timeoutMs);
    try {
      const request = indexedDB.open(PROBE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        // 探测库无需任何对象仓库。
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        finish(true, request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish(false, null);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        finish(false, null);
      };
    } catch {
      clearTimeout(timer);
      finish(false, null);
    }
  });
}

/**
 * 能力探测：当前环境是否可用 OPFS（FileStore）。
 */
export function probeFileStore(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/** localStorage 命名空间前缀（避免与业务/第三方键冲突）。 */
const LS_PREFIX = 'hogo:kv:';

/**
 * 获取 localStorage；不可访问（不存在 / 隐私模式访问即抛）时返回 null。
 *
 * 通过 `window.localStorage` 访问（本文件是数据层唯一允许触碰浏览器存储的边界）。
 */
function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 判断是否为配额超限异常（兼容不同浏览器的 name / code 约定）。 */
function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014;
}

/**
 * 能力探测：localStorage 是否**真实可写**。
 *
 * 仅凭“符号存在”不足以判定可用（隐私模式访问即抛、配额为 0）。这里做一次
 * 写入 + 删除探针，失败即判为不可用。
 */
export function probeLocalStorageKeyValueStore(): boolean {
  const ls = getLocalStorage();
  if (ls === null) {
    return false;
  }
  const probeKey = `${LS_PREFIX}__probe__`;
  try {
    ls.setItem(probeKey, '1');
    ls.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * localStorage 键值仓库：IndexedDB 不可用时的**持久化降级**实现
 * （典型场景：`file://` 双击离线模式 —— IndexedDB 被阻止但 localStorage 可用）。
 *
 * 以「每个 store 一个 JSON 文本」整体存取（`hogo:kv:{store}`），保持与
 * IndexedDB 仓库相同的 `KeyValueStore` 语义；因此可直接被 `IdbRepository`
 * 复用，无需引入新的仓库实现。
 *
 * 写入超出配额时抛 `HogoError`（**绝不静默丢数据**），由上层 UI 明确提示。
 */
export class LocalStorageKeyValueStore implements KeyValueStore {
  /** 读取整个 store（缺失 / 损坏时返回空对象）。 */
  private readBucket(store: StoreName): Record<string, unknown> {
    const ls = getLocalStorage();
    if (ls === null) {
      return {};
    }
    const raw = ls.getItem(`${LS_PREFIX}${store}`);
    if (raw === null) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** 写回整个 store；超配额 / 写入失败抛 HogoError。 */
  private writeBucket(store: StoreName, bucket: Record<string, unknown>): void {
    const ls = getLocalStorage();
    if (ls === null) {
      throw new HogoError('STORAGE_UNAVAILABLE', '浏览器本地存储不可用，项目未保存。', { store });
    }
    try {
      ls.setItem(`${LS_PREFIX}${store}`, JSON.stringify(bucket));
    } catch (err) {
      if (isQuotaExceeded(err)) {
        throw new HogoError(
          'STORAGE_UNAVAILABLE',
          '本地存储空间不足（localStorage 配额已满），项目未保存。请导出项目包或改用本地服务。',
          { store },
        );
      }
      throw new HogoError('STORAGE_UNAVAILABLE', '写入浏览器本地存储失败，项目未保存。', {
        store,
        cause: err,
      });
    }
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return Object.values(this.readBucket(store)) as T[];
  }

  async get<T>(store: StoreName, key: string): Promise<T | null> {
    const bucket = this.readBucket(store);
    return Object.prototype.hasOwnProperty.call(bucket, key) ? (bucket[key] as T) : null;
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    const bucket = this.readBucket(store);
    bucket[key] = value;
    this.writeBucket(store, bucket);
  }

  async delete(store: StoreName, key: string): Promise<void> {
    const bucket = this.readBucket(store);
    if (Object.prototype.hasOwnProperty.call(bucket, key)) {
      delete bucket[key];
      this.writeBucket(store, bucket);
    }
  }
}

/**
 * localStorage 单键 JSON 持久化（`JsonStore<T>` 的浏览器实现）。
 *
 * 为什么用 localStorage 而非 IndexedDB：
 * - `file://` 双击离线模式下 Chrome **阻止** IndexedDB（`open()` 挂起），
 *   而 localStorage 仍然可读写；设置 / AI 配置必须在两种形态下都能持久化，
 *   因此这里选 localStorage 作为唯一后端。
 *
 * 容错契约（对应「脏数据不得白屏」）：
 * - 存储不可访问（隐私模式 / 无 `window`）→ `load` 返回 null；
 * - 键不存在 / JSON 解析失败 → `load` 返回 null；
 * - 解析成功但结构非法 → 交由注入的 `sanitize` 归一化；其返回 null 亦视为无配置。
 * 以上任何路径都**不抛异常**。
 *
 * 本类是本文件（数据层唯一存储边界）的一部分，业务/store 层仅通过注入的
 * `JsonStore<T>` 窄接口使用，不直接触碰 `localStorage`。
 */
export class LocalStorageJsonStore<T> implements JsonStore<T> {
  /**
   * @param key localStorage 键名（调用方保证命名空间前缀，如 `hogo-qa-settings`）
   * @param sanitize 脏数据归一化函数：返回合法值或 null（null 表示回落默认）
   */
  constructor(
    private readonly key: string,
    private readonly sanitize: (raw: unknown) => T | null,
  ) {}

  /** 读取 + 解析 + 归一化；任一环节失败返回 null（不抛）。 */
  load(): T | null {
    const ls = getLocalStorage();
    if (ls === null) {
      return null;
    }
    let raw: string | null;
    try {
      raw = ls.getItem(this.key);
    } catch {
      // 隐私模式等访问即抛：视为无配置，不阻断启动。
      return null;
    }
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 非法 JSON（手动篡改 / 版本残留）：视为无配置。
      return null;
    }
    return this.sanitize(parsed);
  }

  /** 序列化 + 写入；底层不可用 / 超配额时抛 HogoError。 */
  save(value: T): void {
    const ls = getLocalStorage();
    if (ls === null) {
      throw new HogoError('STORAGE_UNAVAILABLE', '浏览器本地存储不可用，AI 配置未保存。', {
        key: this.key,
      });
    }
    try {
      ls.setItem(this.key, JSON.stringify(value));
    } catch (err) {
      if (isQuotaExceeded(err)) {
        throw new HogoError('STORAGE_UNAVAILABLE', '本地存储空间不足，AI 配置未保存。', {
          key: this.key,
        });
      }
      throw new HogoError('STORAGE_UNAVAILABLE', '写入浏览器本地存储失败，AI 配置未保存。', {
        key: this.key,
        cause: err,
      });
    }
  }
}

