/**
 * blobFallback：文件下载/上传的降级方案。
 *
 * 出处：架构文档 §7.4（File System Access API 不可用时用 Blob + a.download）。
 * 本模块导出纯逻辑 helper（不硬绑定 DOM），真正的 DOM 触发集中在
 * `triggerDownload`，仅在浏览器环境调用；Node 测试不触碰它。
 */

/**
 * 构造用于下载的 blob 元信息（不触碰 DOM，可测试）。
 */
export interface DownloadPayload {
  /** 建议文件名（含扩展名）。 */
  fileName: string;
  /** MIME 类型。 */
  mimeType: string;
  /** 文本内容。 */
  content: string;
}

/** 常见导出 MIME。 */
export const MIME_JSON = 'application/json;charset=utf-8';
export const MIME_CSV = 'text/csv;charset=utf-8';

/**
 * 在浏览器中触发一次文件下载（Blob + <a download>）。
 *
 * 该函数包含 DOM 调用，仅应在浏览器运行时调用；Node 测试请直接
 * 使用 `buildDownloadPayload` 校验内容而不触发下载。
 */
export function triggerDownload(payload: DownloadPayload): void {
  const blob = new Blob([payload.content], { type: payload.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = payload.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 构造下载 payload（纯函数，便于测试）。 */
export function buildDownloadPayload(
  fileName: string,
  content: string,
  mimeType: string = MIME_JSON,
): DownloadPayload {
  return { fileName, mimeType, content };
}
