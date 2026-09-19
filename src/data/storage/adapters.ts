/**
 * 存储适配器抽象接口（依赖注入边界）。
 *
 * 硬性要求（team-lead T02 指令）：`src/data/**` 不得把 `indexedDB` /
 * `navigator.storage` 直接写死在业务逻辑里。所有对浏览器存储的访问
 * 都通过本文件定义的窄接口注入，业务代码（repositories / storage）
 * 只依赖接口；Node 测试注入内存实现或构造 in-memory fake。
 *
 * 出处分层：架构文档 §0.1（Repository 抽象）、§7.4（存储降级）。
 */

/** 记录集合名（对应 IndexedDB object store）。 */
export type StoreName = 'projects' | 'measurements';

/** 测量值写入记录（Repository 层不感知 schema，仅按 ref 存取）。 */
export interface MeasurementRecordBlob {
  /** 关联的特性 id（便于调试/审计）。 */
  characteristicId: string;
  /** OPFS 文件引用；为 null 时 values 内联在 IndexedDB 记录中。 */
  blobRef: string | null;
  /** 内联测量值（blobRef 为空时使用）。 */
  values: number[];
}

/**
 * 键值对象仓库接口（IndexedDB 的最小抽象）。
 *
 * 只暴露 repository 真正需要的能力，便于内存实现与 fake 实现替换。
 */
export interface KeyValueStore {
  /** 列出某 store 的全部记录值（不含主键）。 */
  getAll<T>(store: StoreName): Promise<T[]>;
  /** 按主键读取。 */
  get<T>(store: StoreName, key: string): Promise<T | null>;
  /** 写入/覆盖。 */
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  /** 按主键删除。 */
  delete(store: StoreName, key: string): Promise<void>;
}

/** 单个文件条目（OPFS 抽象）。 */
export interface FileStore {
  /** 写入文本内容到指定文件名（覆盖）。 */
  writeText(fileName: string, content: string): Promise<void>;
  /** 读取文本内容；不存在返回 null。 */
  readText(fileName: string): Promise<string | null>;
  /** 删除文件；不存在静默返回。 */
  delete(fileName: string): Promise<void>;
  /** 判断文件是否存在。 */
  exists(fileName: string): Promise<boolean>;
}

/** 存储能力探测结果。 */
export interface StorageCapabilities {
  /** IndexedDB（KeyValueStore）是否可用。 */
  hasKeyValue: boolean;
  /** OPFS（FileStore）是否可用。 */
  hasFileStore: boolean;
}

/**
 * 通用 JSON 键值持久化接口（单键、整对象存取）。
 *
 * 用途：为「设置 / AI 配置」等**非项目数据**提供窄接口持久化，
 * 与 `KeyValueStore`（面向 projects/measurements 记录集）区分解耦。
 *
 * 关键约束（脏数据容错）：`load` 在「键缺失 / 非法 JSON / 校验不通过」
 * 任一情况下都必须返回 `null`（**不得抛异常**），由调用方回落默认值，
 * 避免损坏的 localStorage 内容导致应用启动白屏。
 *
 * 出处：架构文档 §7.4；本轮「AI 配置持久化接线」需求。
 */
export interface JsonStore<T> {
  /** 读取并反序列化；缺失 / 损坏 / 校验失败一律返回 null（不抛）。 */
  load: () => T | null;
  /** 序列化并写入；底层不可用或超配额时抛 `HogoError`（绝静默丢数据）。 */
  save: (value: T) => void;
}
