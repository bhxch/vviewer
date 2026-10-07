// ooxml.ts — OOXML（OPC 包）预检共用工具：docx/xlsx/pptx 三渲染器共享。
// OPC 包本质是 ZIP；dispatcher 传给 sniff 的 head 只有 8KB，[Content_Types].xml
// 通常是首个条目，但必需部件（word/document.xml 等）可能位于任意偏移，head 内
// 部件名预检不可靠——SDD Task 5 裁决：sniff 永不改派，部件缺失/伪 OOXML（改名的
// 旧格式或损坏文件）由 render 侧解析库自然报错，经 core dispatcher 落为错误卡。
import type { Detection } from '@vviewer/core';

/**
 * render 侧早失败（docx/pptx 专用）：head 缺 ZIP 签名时抛可读的中文错误，
 * 替代解析库的英文堆栈（错误卡正文）。xlsx 不做此检查：旧版 .xls 是 OLE/BIFF，
 * SheetJS 可直接解析。
 */
export function assertZipSignature(buffer: Uint8Array, kind: string): void {
  const isZip = buffer.length >= 4
    && buffer[0] === 0x50 && buffer[1] === 0x4b
    && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (!isZip) {
    throw new Error(`不是有效的 ${kind} 文件：缺少 OOXML（ZIP）签名，可能是旧版 Office 格式或文件已损坏`);
  }
}

/**
 * sniff 统一实现：无论预检结果如何都返回 null（不改派）。
 * - head 非 ZIP（如改名 .doc 的 OLE 文件）：无更合适的改派目标，返回 null，
 *   render 侧早失败给出明确错误。
 * - head 是 ZIP：无法在 8KB 内可靠校验必需部件，返回 null，render 全量解析定论。
 */
export async function sniffOoxml(_head: Uint8Array, _det: Detection): Promise<null> {
  return null;
}
