<script lang="ts">
  import AppShell from '../lib/AppShell.svelte';
  import { openFiles, openDirectoryViaInput } from '../lib/openFlow.svelte';

  /** 递归枚举拖入目录：readEntries 每批可能不满，需循环读尽 */
  async function collectFiles(entry: FileSystemEntry, path: string, files: File[]): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      );
      if (file) files.push(Object.assign(file, { webkitRelativePath: path }));
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

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    // webkitGetAsEntry 必须在事件处理同步阶段对每个 item 调用（拖拽结束后 dataTransfer 失效）
    const entries = e.dataTransfer?.items
      ? [...e.dataTransfer.items].map((it) => it.webkitGetAsEntry()).filter((x): x is FileSystemEntry => x !== null)
      : [];
    const dirEntry = entries.find((en) => en.isDirectory);
    if (dirEntry) {
      const files: File[] = [];
      await collectFiles(dirEntry, dirEntry.name, files);
      if (files.length) openDirectoryViaInput(files as unknown as FileList);
      return;
    }
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length) openFiles([...dropped]);
  }
</script>

<svelte:window
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => void onDrop(e)} />
<AppShell />
