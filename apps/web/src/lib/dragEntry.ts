/**
 * 拖拽目录收集：从 DataTransfer 提取 FileSystemEntry 并递归收集 File。
 * 提取为纯函数以便 jsdom 单测（手造 entry 桩），+page.svelte 只做事件接线。
 */

/**
 * webkitGetAsEntry 必须在事件处理的同步阶段对每个 item 调用——
 * 拖拽事件结束后 dataTransfer 即失效，故本函数不可延后调用。
 */
export function getFileSystemEntries(dt: DataTransfer | null): FileSystemEntry[] {
  const items = dt?.items;
  return items
    ? [...items].map((it) => it.webkitGetAsEntry()).filter((x): x is FileSystemEntry => x !== null)
    : [];
}

/** 递归枚举拖入目录：readEntries 每批可能不满，需循环读尽 */
export async function collectFiles(entry: FileSystemEntry, path: string, files: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    );
    if (!file) return;
    // webkitRelativePath 是 File.prototype 上的只读访问器，Object.assign 会抛 TypeError；
    // 用 defineProperty 写入可配置自有属性遮蔽原型 getter（与 webkitdirectory input 行为一致）
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true });
    files.push(file);
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (batch.length === 0) break;
      for (const en of batch) await collectFiles(en, `${path}/${en.name}`, files);
    }
  }
}

/**
 * 收集拖入内容中第一个目录的全部文件；不含目录条目时返回 null（调用方回退到单文件通道）。
 */
export async function collectDirectoryFiles(dt: DataTransfer | null): Promise<File[] | null> {
  const dirEntry = getFileSystemEntries(dt).find((en) => en.isDirectory);
  if (!dirEntry) return null;
  const files: File[] = [];
  await collectFiles(dirEntry, dirEntry.name, files);
  return files;
}
