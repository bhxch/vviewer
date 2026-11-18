// store.ts — 单文件数据面（spec H T3）。
//
// 扩展的文档来源恒为**单个本地文件**（custom editor 一次打开一个 URI）——故用 core 的
// singleFile 型 TreeStore（`createSingleFileStore`，packages/vviewer-core/src/tree/singleFile.ts）
// 注入 dispatcher 的 `FileSource.store`：渲染器与注入缝拿到的 source 形态与 web 端一致。
//
// 字节面：webview 内以 `new File([bytes], name)` 构造（浏览器 File API——jsdom 亦有），
// store 读回同一份字节。
import { createSingleFileStore, type FileSource } from '@bhxch/vviewer-core';

/**
 * 构造单文件来源。
 *
 * @param bytes 文件字节
 * @param name 文件名（含扩展名——扩展名决定渲染器认领）
 * @param path 路径（store 内路径；扩展内即文件路径）
 */
export function createSingleFileSource(
  bytes: Uint8Array,
  name: string,
  path: string
): FileSource {
  // BlobPart 的 ArrayBuffer 泛型收窄（TS 5.9+）：字节面在此复制一次到 File 内部缓冲
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name);
  const store = createSingleFileStore(file);
  return {
    storeId: store.id,
    storeLabel: name,
    path,
    name,
    store,
    size: bytes.length
  };
}
