import { describe, expect, it, vi } from 'vitest';
import { createRemoteStore } from '../src/tree/remote';
import { createLocalFilesStore } from '../src/tree/localFiles';
import { createLocalFsStore } from '../src/tree/localFs';

describe('store read 的 signal 取消语义', () => {
  it('remote：signal 已 abort 时 fetch 被取消（AbortError reject），不发出网络等待', async () => {
    const store = createRemoteStore('http://127.0.0.1:1', null, 't');
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.read('a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('remote：在飞读被 abort 取消（fetch 挂起中 abort → reject AbortError）', async () => {
    // 挂起服务器：连接保持不响应（received 置位 = 请求已抵达服务器的事件钩子）
    const http = await import('node:http');
    let received = false;
    const server = http.createServer(() => {
      received = true; // 永不应答，仅记录「请求已到」——abort 时序的事件驱动锚点
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const store = createRemoteStore(`http://127.0.0.1:${port}`, null, 't');
      const controller = new AbortController();
      const p = store.read('a.txt', { signal: controller.signal });
      // 确定性时序（deferred 清偿 Task 1 ⑤）：请求确已抵达服务器后再 abort——
      // 取代 setTimeout(20) 的随机等待（慢机上 fetch 未发出即 abort 会走
      // 「预 abort 短路」分支而非「在飞取消」分支，用例测的面随之漂移）
      await vi.waitFor(() => expect(received).toBe(true));
      controller.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('localFiles：signal 预先 aborted → 立即 reject（降级语义）', async () => {
    // jsdom 的 File 无 webkitRelativePath，且 store 契约要求 root/文件 两段路径 read
    // 才可命中——按仓库既有测试约定（treeLocal.test.ts mkFile）补相对路径与 label；
    // 断言语义与简报一致
    const file = Object.assign(new File([new TextEncoder().encode('a\n')], 'a.txt'), {
      webkitRelativePath: 'd/a.txt'
    });
    const store = createLocalFilesStore([file], 't');
    const controller = new AbortController();
    controller.abort();
    // 取消错误统一（deferred 清偿 Task 1）：DOMException AbortError——message 不变，
    // 错误身份可判别（Task 3 渲染器按 err.name === 'AbortError' 区分取消与读失败）
    await expect(
      store.read('a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError', message: '读取已取消' });
  });

  it('localFs：signal 预先 aborted → 立即 reject（读取已取消，localFiles 同款入口截断）', async () => {
    // File System Access handle 最小 mock 面：read 入口在 resolve 之前即截断，
    // 目录句柄只需 kind/name 满足构造；values() 供 resolve 可达性兜底
    const fileHandle = {
      kind: 'file',
      name: 'a.txt',
      getFile: async () => new File([new TextEncoder().encode('a\n')], 'a.txt')
    };
    const dirHandle = {
      kind: 'directory',
      name: 'd',
      values: async function* () {
        yield fileHandle;
      }
    } as unknown as FileSystemDirectoryHandle;
    const store = createLocalFsStore(dirHandle);
    const controller = new AbortController();
    controller.abort();
    // 错误身份统一（deferred 清偿 Task 5 合批：localFs 补齐 localFiles/singleFile 同款
    // DOMException 形态）——message 不变，name 可判别（isAbortError 同源判定消费面）
    await expect(
      store.read('a.txt', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError', message: '读取已取消' });
  });
});
