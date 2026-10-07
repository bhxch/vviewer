// archive.ts — 压缩包树渲染器（M4 Task 3 zip / Task 4 tar·7z·rar）。
// render 内按 magic 分派：PK 头走 jszip（createZipStore），其余走 libarchive.js wasm
// （createLibarchiveStore，支持 tar/tar.gz/tgz/tbz2/xz/7z/rar）。自带简单树 UI（<details>
// 懒展开），点击文件条目派发 'vv-open-entry' CustomEvent（apps/web 的
// openFlow.bindArchiveOpenEvents 监听并 addTab），不改 Renderer 接口、不与 web 包耦合；
// mountArchiveTree 独立导出供 web 侧复用。构造失败（加密/无法识别）抛中文错误，
// 由 dispatcher 的错误卡兜底。
import type { FileSource, Detection, RenderedInstance, Renderer, TreeStore, TreeNode } from '@vviewer/core';
import { createZipStore, archiveChainOf } from './zipStore';
import { createLibarchiveStore } from './libarchiveStore';

/** 点击包内文件条目时派发的窗口事件名 */
export const ARCHIVE_OPEN_EVENT = 'vv-open-entry';

/** ARCHIVE_OPEN_EVENT 的 detail 形状 */
export interface ArchiveOpenDetail {
  store: TreeStore;
  path: string;
  name: string;
}

/** zip magic：'PK' + 03/05/07（普通/空/分卷 zip）；其余格式交给 libarchive 识别 */
function isZipMagic(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  );
}

/**
 * 在 target 内挂载包内条目树：目录为可折叠 <details>（首次展开时 listChildren 懒加载），
 * 文件为可点击行（onopen 回调）。返回实例 destroy。
 * 样式复用全局 .vv-tree / .vv-tree-row 类（app.css）。
 */
export function mountArchiveTree(
  target: HTMLElement,
  store: TreeStore,
  onopen: (path: string, name: string) => void
): { destroy(): void } {
  const root = document.createElement('ul');
  root.className = 'vv-tree vv-archive';
  target.replaceChildren(root);
  let destroyed = false;

  async function expandInto(list: HTMLElement, path: string): Promise<void> {
    const kids = await store.listChildren(path);
    if (destroyed) return;
    const frag = document.createDocumentFragment();
    for (const node of kids) frag.append(nodeRow(node));
    list.replaceChildren(frag);
  }

  function nodeRow(node: TreeNode): HTMLElement {
    if (node.kind === 'dir') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.className = 'vv-tree-row';
      const caret = document.createElement('span');
      caret.className = 'vv-tree-caret';
      caret.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'vv-tree-name';
      name.textContent = node.name;
      summary.append(caret, name);
      const list = document.createElement('ul');
      list.className = 'vv-tree';
      details.append(summary, list);
      // 首次展开懒加载子项；summary 的 open 状态由 details 原生维护
      details.addEventListener('toggle', () => {
        if (details.open && list.childElementCount === 0) void expandInto(list, node.path);
      });
      return details;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'vv-tree-row';
    const caret = document.createElement('span');
    caret.className = 'vv-tree-caret';
    const name = document.createElement('span');
    name.className = 'vv-tree-name';
    name.textContent = node.size !== undefined ? `${node.name}（${node.size} B）` : node.name;
    row.append(caret, name);
    row.onclick = () => onopen(node.path, node.name);
    return row;
  }

  void expandInto(root, '');
  return {
    destroy() {
      destroyed = true;
      root.remove();
    }
  };
}

export const archiveRenderer: Renderer = {
  id: 'archive',
  label: '压缩包',
  extensions: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, _det: Detection): Promise<RenderedInstance> {
    // 递归深度接线：由来源 store id 的前导归档段（zip/libarchive）推导父链（顶层归档的
    // store 是 localfiles/single 等非归档来源 → 链空 → depth 0；包内第 n 层归档 → depth n-1）
    const parentChain = archiveChainOf(source.storeId);
    const store = isZipMagic(buffer)
      ? await createZipStore(buffer, parentChain || undefined, source.name)
      : await createLibarchiveStore(buffer, parentChain || undefined, source.name);
    // 本 store 实例是否派发过包内条目点击：派发过的实例由内层 tab 持有（懒读），
    // 其释放接线在 openFlow 的 tab 关闭路径；未派发过的实例无任何人引用，destroy 即关闭
    let entryOpened = false;
    const tree = mountArchiveTree(target, store, (path, name) => {
      entryOpened = true;
      // 解耦通道：包内文件点击 → 窗口事件；apps/web openFlow.bindArchiveOpenEvents 监听后 addTab，
      // 派发器按扩展名自然路由（txt→code、png→image、zip→递归…）
      window.dispatchEvent(new CustomEvent<ArchiveOpenDetail>(ARCHIVE_OPEN_EVENT, { detail: { store, path, name } }));
    });
    return {
      destroy() {
        tree.destroy();
        // worker 释放收口（T7）：没有内层 tab 持有（从未点开过条目）的 libarchive store
        // 在实例 destroy 时立即 close（终止 worker）；zip store 无 close，可选调用为 no-op
        if (!entryOpened) store.close?.();
      }
    };
  }
};
