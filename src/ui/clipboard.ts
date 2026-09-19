/**
 * clipboard —— 剪贴板写入工具（UI 层）。
 *
 * 优先 `navigator.clipboard.writeText`；不可用时退化为 `document.execCommand('copy')`
 * （兼容旧浏览器 / 非安全上下文）。
 */

/**
 * 将文本写入系统剪贴板。
 *
 * @param text 待复制文本
 * @returns 是否成功
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { clipboard?: { writeText: (t: string) => Promise<void> } };
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走降级方案
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
