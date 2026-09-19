/**
 * 内存版存储适配器：供测试与降级场景使用。
 *
 * 出处：架构文档 §7.4（IndexedDB 不可用时 MemoryRepository 兜底）；
 * team-lead T02 要求「存储与文件读取走依赖注入」以便 Node 测试。
 */

import type { FileStore, KeyValueStore, StoreName } from './adapters';

/**
 * 内存键值仓库：以一个 Map 模拟 IndexedDB 的对象仓库。
 * 数据仅存活于当前进程，进程结束即丢失（降级场景需提示用户导出 JSON）。
 */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly stores: Map<StoreName, Map<string, unknown>>;

  constructor() {
    this.stores = new Map<StoreName, Map<string, unknown>>([
      ['projects', new Map<string, unknown>()],
      ['measurements', new Map<string, unknown>()],
    ]);
  }

  private bucket(store: StoreName): Map<string, unknown> {
    let m = this.stores.get(store);
    if (!m) {
      m = new Map<string, unknown>();
      this.stores.set(store, m);
    }
    return m;
  }

  /** 深拷贝，避免调用方后续修改污染已存数据（贴近真实 DB 的序列化语义）。 */
  private static clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return Array.from(this.bucket(store).values()).map((v) => MemoryKeyValueStore.clone(v as T));
  }

  async get<T>(store: StoreName, key: string): Promise<T | null> {
    const v = this.bucket(store).get(key);
    return v === undefined ? null : MemoryKeyValueStore.clone(v as T);
  }

  async put<T>(store: StoreName, key: string, value: T): Promise<void> {
    this.bucket(store).set(key, MemoryKeyValueStore.clone(value));
  }

  async delete(store: StoreName, key: string): Promise<void> {
    this.bucket(store).delete(key);
  }

  /** 测试辅助：清空全部数据。 */
  clear(): void {
    for (const m of this.stores.values()) {
      m.clear();
    }
  }
}

/** 内存文件仓库：以 Map<string,string> 模拟 OPFS 文件。 */
export class MemoryFileStore implements FileStore {
  private readonly files: Map<string, string> = new Map<string, string>();

  async writeText(fileName: string, content: string): Promise<void> {
    this.files.set(fileName, content);
  }

  async readText(fileName: string): Promise<string | null> {
    const v = this.files.get(fileName);
    return v === undefined ? null : v;
  }

  async delete(fileName: string): Promise<void> {
    this.files.delete(fileName);
  }

  async exists(fileName: string): Promise<boolean> {
    return this.files.has(fileName);
  }

  /** 测试辅助：清空全部文件。 */
  clear(): void {
    this.files.clear();
  }
}
