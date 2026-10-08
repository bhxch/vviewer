<script lang="ts">
  import AppShell from '../lib/AppShell.svelte';
  import { openFiles, openDirectoryViaInput } from '../lib/openFlow.svelte';
  import { collectDirectoryFiles } from '../lib/dragEntry';

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    // webkitGetAsEntry 的同步调用约束由 collectDirectoryFiles 内部的 getFileSystemEntries 保证
    const files = await collectDirectoryFiles(e.dataTransfer);
    if (files) {
      // 空数组也走统一通道：openDirectoryViaInput 内给"所选文件夹为空"的一次性提示
      openDirectoryViaInput(files);
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
