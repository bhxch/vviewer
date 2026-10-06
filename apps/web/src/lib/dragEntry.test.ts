import { describe, it, expect } from 'vitest';
import { collectFiles, getFileSystemEntries, collectDirectoryFiles } from './dragEntry';

/** 手造 File 桩：jsdom 的 File 可直接 defineProperty webkitRelativePath */
function stubFile(name: string, content = 'x'): File {
  return new File([content], name, { type: 'text/plain' });
}

interface EntryStubOptions {
  name: string;
  fileError?: boolean;
}

/** 手造文件条目桩：file(success, error) 回调风格与 FileSystemFileEntry 一致 */
function fileEntry({ name, fileError }: EntryStubOptions): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (success, error) => {
      if (fileError) error?.(new DOMException('denied'));
      else success(stubFile(name));
    }
  } as unknown as FileSystemEntry;
}

/** 手造目录条目桩：createReader 按预定批次返回，末尾以空批次结束（复现 Chrome 分批语义） */
function dirEntry(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  let i = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (success: (entries: FileSystemEntry[]) => void, error: (e: DOMException) => void) => {
        const batch = batches[i] ?? null;
        i += 1;
        if (batch === null) error(new DOMException('read failed'));
        else success(batch);
      }
    })
  } as unknown as FileSystemEntry;
}

describe('collectFiles', () => {
  it('单个文件：webkitRelativePath 以自有属性写入且值为传入的完整路径', async () => {
    const files: File[] = [];
    // path 参数即该条目的完整相对路径（与真实用法一致：顶层文件路径由调用方拼好）
    await collectFiles(fileEntry({ name: 'a.txt' }), 'dir/a.txt', files);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('a.txt');
    expect(files[0]!.webkitRelativePath).toBe('dir/a.txt');
    // 遮蔽原型访问器的自有属性，需可配置（否则严格模式二次写入会抛错）
    const desc = Object.getOwnPropertyDescriptor(files[0]!, 'webkitRelativePath');
    expect(desc?.configurable).toBe(true);
  });

  it('目录递归：路径逐级拼接', async () => {
    const files: File[] = [];
    const root = dirEntry('root', [
      [fileEntry({ name: 'a.txt' }), dirEntry('sub', [[fileEntry({ name: 'b.txt' })], []])],
      []
    ]);
    await collectFiles(root, 'root', files);
    expect(files.map((f) => f.webkitRelativePath)).toEqual(['root/a.txt', 'root/sub/b.txt']);
  });

  it('readEntries 分批：循环读尽直到空批次', async () => {
    const files: File[] = [];
    // 首批只返回 1 个条目，第二批再返回 1 个——模拟 Chrome 每批最多 100 条的截断行为
    const root = dirEntry('root', [[fileEntry({ name: '1.txt' })], [fileEntry({ name: '2.txt' })], []]);
    await collectFiles(root, 'root', files);
    expect(files.map((f) => f.name)).toEqual(['1.txt', '2.txt']);
  });

  it('file() 失败的条目被跳过而非中断', async () => {
    const files: File[] = [];
    const root = dirEntry('root', [[
      fileEntry({ name: 'gone.txt', fileError: true }),
      fileEntry({ name: 'ok.txt' })
    ], []]);
    await collectFiles(root, 'root', files);
    expect(files.map((f) => f.name)).toEqual(['ok.txt']);
    expect(files[0]!.webkitRelativePath).toBe('root/ok.txt');
  });
});

describe('getFileSystemEntries / collectDirectoryFiles', () => {
  it('items 为空或缺 dataTransfer 时返回空/null', () => {
    expect(getFileSystemEntries(null)).toEqual([]);
    return expect(collectDirectoryFiles(null)).resolves.toBeNull();
  });

  it('含目录条目时收集整目录；纯文件拖入返回 null（走单文件通道）', async () => {
    const dir = dirEntry('pkg', [[fileEntry({ name: 'a.txt' })], []]);
    const items = [
      { webkitGetAsEntry: () => fileEntry({ name: 'loose.txt' }) },
      { webkitGetAsEntry: () => dir }
    ] as unknown as DataTransferItem[];
    const dt = { items } as unknown as DataTransfer;
    expect(getFileSystemEntries(dt)).toHaveLength(2);
    const files = await collectDirectoryFiles(dt);
    expect(files?.map((f) => f.webkitRelativePath)).toEqual(['pkg/a.txt']);

    const fileOnly = {
      items: [{ webkitGetAsEntry: () => fileEntry({ name: 'loose.txt' }) }]
    } as unknown as DataTransfer;
    return expect(collectDirectoryFiles(fileOnly)).resolves.toBeNull();
  });
});
