// markdownImages.ts — markdown 相对图片 → 同 store 文件 blob URL 的解析逻辑。
// 从 viewer.ts 抽出为无 $app 依赖的纯模块：除接线外可被 vitest 直测。
// 遗留清理批次 1（L4）：解析前加大小上限——>IMAGE_MAX_BYTES 的图片跳过并保留
// 原 src（404 现状），避免渲染一篇文档时把超大图片整读进内存/生成巨型 blob。
import type { TreeStore } from '@vviewer/core';

/** 相对图片解析大小上限（与富文本渲染降级阈值 MARKUP_MAX_BYTES 同量级） */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 图片扩展名 → blob MIME（与 render-media image.ts 的可播子集一致；未知给空串由浏览器嗅探） */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml'
};

/**
 * 相对 src → store 内路径：以当前文件目录为基，逐段规范 `.`/`..`；
 * 越出 store 根（`..` 弹空）返回 null。目录树路径以 `/` 分隔（RemoteStore/本地
 * store 一致），src 不做百分号解码——树内路径是原始名，与 img src 的字面量对齐。
 */
export function resolveInStorePath(sourcePath: string, src: string): string | null {
  const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const seg of `${dir}/${src}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * 相对 src → 同 store 文件的 blob URL；解析失败/找不到/超过大小上限返回 null
 * （renderer 保留原 src，维持 404 现状）。store 读取抛错由调用方捕获后同义处理。
 * 大小检查两道：read 前查 listChildren 的 TreeNode.size（store 可报大小时零读取
 * 跳过）；read 后兜底查字节数（size 缺失的 store 也不再生成超大 blob）。
 */
export async function resolveImageBlobUrl(
  store: TreeStore,
  sourcePath: string,
  src: string
): Promise<string | null> {
  const path = resolveInStorePath(sourcePath, src);
  if (path === null || path === '') return null;
  // read 前置检查：目标所在目录的 TreeNode 已知大小时，超限直接跳过（零读取）
  try {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const node = (await store.listChildren(dir)).find((n) => n.path === path);
    if (node?.size !== undefined && node.size > IMAGE_MAX_BYTES) return null;
  } catch {
    // 目录列举失败（如平铺 store）不阻断：退回 read 后检查
  }
  const bytes = await store.read(path);
  if (bytes.byteLength > IMAGE_MAX_BYTES) return null; // read 后兜底
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  const blob = new Blob([bytes], { type: IMAGE_MIME[ext] ?? '' });
  return URL.createObjectURL(blob);
}
