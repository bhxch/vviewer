// foreignWorkerBridge.test.ts — 跨域 Worker blob 引导桥单测（终审修复波 M-1）。
// jsdom 无 Worker（typeof Worker === 'undefined'，模块级装配幂等护栏正好放行 import
// 副作用）：以 EventTarget 派生 FakeWorker 注入全局后显式装配桥。锚四面：
// ① M1：bootstrap reject（失败标记）→ 桥实例派发标准 error 事件（worker onerror
//    消费面 → foreign 渲染既有错误卡片），缓冲弃置不 flush（CDN 监听未挂，flush 即
//    静默丢帧）——修复面：此前 bootstrap 链无 catch，失败即静默挂死；
// ② 引导体脚本含 .catch 失败回发（CDN 断链面脚本级锚，取 createObjectURL 捕获的
//    Blob 文本）；
// ③ 就绪标记 → 缓冲按序放行（既有行为回归锚）；
// ④ 同源 URL 直通不包（零缓冲，FO2-02 回归锚）。
import { beforeEach, describe, expect, it } from 'vitest';

import { installForeignWorkerBridge } from './foreignWorkerBridge';

const READY_MARKER = '__vvForeignWorkerBridgeReady';
const BOOTSTRAP_ERROR = '__vvForeignWorkerBridgeError';
const CDN_URL = 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/psd.worker.js';

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly url: string | URL;
  readonly options?: WorkerOptions;
  readonly sent: unknown[] = [];
  constructor(url: string | URL, options?: WorkerOptions) {
    super();
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }
  postMessage(data: unknown): void {
    this.sent.push(data);
  }
  terminate(): void {}
}

const blobs: Blob[] = [];

function install(): typeof Worker {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  installForeignWorkerBridge();
  return window.Worker;
}

function sentOf(w: Worker): unknown[] {
  return FakeWorker.instances.find((i) => i === (w as unknown as FakeWorker))?.sent ?? [];
}

beforeEach(() => {
  FakeWorker.instances = [];
  blobs.length = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blobs.push(b);
    return `blob:mock-${blobs.length}`;
  };
});

describe('ForeignBridgedWorker', () => {
  it('M1：bootstrap reject 失败标记 → error 事件收口，缓冲弃置不 flush', () => {
    const Bridged = install();
    const w = new Bridged(CDN_URL, { type: 'module' });
    const errors: string[] = [];
    w.addEventListener('error', (e) => errors.push((e as ErrorEvent).message));
    w.postMessage('first-request');
    expect(sentOf(w)).toEqual([]); // 就绪前缓冲（不直通）
    w.dispatchEvent(
      new MessageEvent('message', {
        data: { [READY_MARKER]: false, [BOOTSTRAP_ERROR]: 'net::ERR_INTERNET_DISCONNECTED' }
      })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('net::ERR_INTERNET_DISCONNECTED');
    expect(sentOf(w)).toEqual([]); // 失败后缓冲弃置：CDN 模块监听未挂，flush 即丢帧
  });

  it('M1：引导体脚本含动态 import .catch 失败回发（脚本级锚）', async () => {
    const Bridged = install();
    new Bridged(CDN_URL, { type: 'module' });
    expect(blobs).toHaveLength(1);
    const script = await blobs[0]?.text();
    expect(script).toContain(').catch(');
    expect(script).toContain(`${JSON.stringify(READY_MARKER)}: false`);
    expect(script).toContain(JSON.stringify(BOOTSTRAP_ERROR));
  });

  it('就绪标记 → 缓冲按序放行，就绪后 postMessage 直通（既有行为回归锚）', () => {
    const Bridged = install();
    const w = new Bridged(CDN_URL, { type: 'module' });
    w.postMessage('m1');
    w.postMessage('m2');
    expect(sentOf(w)).toEqual([]);
    w.dispatchEvent(new MessageEvent('message', { data: { [READY_MARKER]: true } }));
    expect(sentOf(w)).toEqual(['m1', 'm2']);
    w.postMessage('m3');
    expect(sentOf(w)).toEqual(['m1', 'm2', 'm3']);
  });

  it('同源 URL 直通不包（零缓冲，不经引导体）', () => {
    const Bridged = install();
    const w = new Bridged(`${location.origin}/libarchive/worker-bundle.js`, { type: 'module' });
    w.postMessage('direct');
    expect(sentOf(w)).toEqual(['direct']);
    expect(blobs).toHaveLength(0);
  });
});
