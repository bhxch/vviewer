// links.test.ts — 相对链接 / 相对图片解析契约（spec H T5）。
//
// 覆盖面：相对图片 → blob URL（宿主读 sibling bytes）；相对链接 → 命中/缺件两态；
// 缺件 → 提示回调（顶部提示条）；命中 → 请求宿主切文档。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createImageResolver,
  createLinkOpener,
  createLinkResolver,
  type LinkBridge
} from '../src/webview/links';

/** jsdom 无 URL.createObjectURL（blob URL 面）——按需打桩 */
const originalCreateObjectURL = URL.createObjectURL;

beforeEach(() => {
  (URL as unknown as { createObjectURL: (obj: Blob) => string }).createObjectURL = () =>
    'blob:mock-object-url';
});

afterEach(() => {
  (URL as unknown as { createObjectURL?: (obj: Blob) => string }).createObjectURL =
    originalCreateObjectURL;
});

/** FileSourceLike 夹具（storeId/storeLabel/path/name 四字段） */
const SOURCE = { storeId: 's', storeLabel: 's', path: 'doc.md', name: 'doc.md' };

function makeBridge(readFile: (path: string) => Promise<Uint8Array | null>): LinkBridge & {
  navigate: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn();
  return { readFile: vi.fn(readFile), navigate };
}

describe('相对图片解析', () => {
  it('命中 → blob URL', async () => {
    const bridge = makeBridge(async () => new Uint8Array([1, 2, 3]));
    const resolver = createImageResolver(bridge);
    const url = await resolver('img/a.png', SOURCE);
    expect(url).toBe('blob:mock-object-url');
  });

  it('缺件 → null（保留原 src，维持 404 现状）', async () => {
    const bridge = makeBridge(async () => null);
    const resolver = createImageResolver(bridge);
    const url = await resolver('img/a.png', SOURCE);
    expect(url).toBeNull();
  });

  it('空字节 → null（不建空 blob）', async () => {
    const bridge = makeBridge(async () => new Uint8Array(0));
    const resolver = createImageResolver(bridge);
    expect(await resolver('img/a.png', SOURCE)).toBeNull();
  });
});

describe('相对链接解析', () => {
  it('命中 → file 目标', async () => {
    const bridge = makeBridge(async () => new Uint8Array([1]));
    const resolver = createLinkResolver(bridge);
    const target = await resolver('sub/other.md', SOURCE);
    expect(target).toEqual({ kind: 'file', storeId: 'single', path: 'sub/other.md' });
  });

  it('缺件 → missing 目标（带 path）', async () => {
    const bridge = makeBridge(async () => null);
    const resolver = createLinkResolver(bridge);
    const target = await resolver('sub/other.md', SOURCE);
    expect(target).toEqual({ kind: 'missing', path: 'sub/other.md' });
  });
});

describe('相对链接打开', () => {
  it('file 目标 → 请求宿主切文档（不提示）', () => {
    const bridge = makeBridge(async () => null);
    const onMissing = vi.fn();
    const opener = createLinkOpener(bridge, onMissing);
    opener({ kind: 'file', storeId: 'single', path: 'sub/other.md' }, 'sub/other.md', SOURCE);
    expect(bridge.navigate).toHaveBeenCalledWith('sub/other.md');
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('missing 目标 → 提示回调（顶部提示条），不请求导航', () => {
    const bridge = makeBridge(async () => null);
    const onMissing = vi.fn();
    const opener = createLinkOpener(bridge, onMissing);
    opener({ kind: 'missing', path: 'sub/gone.md' }, 'sub/gone.md', SOURCE);
    expect(onMissing).toHaveBeenCalledWith('sub/gone.md');
    expect(bridge.navigate).not.toHaveBeenCalled();
  });
});
