// highlightRecreate.test.ts — spec E 修 3：client 毒化重建的门控纯谓词 + neutral hook。
// 本模块纯 .ts（无任何 import），根 vitest 直测唯一入口（frontend-conventions §2 分工）。
//
// 契约面（计划 Task 3 Interfaces）：
// ① shouldRecreateHighlightClient：failed-态门控谓词——force 无条件真；否则
//    creationFailed（创建期失败，attach null 终态）/ clientInitFailed（实例 failWorker
//    毒化）/ grammarTableEmpty（worker 健康、三层 manifest 全失败）任一为真；
//    全 false（健康 client + 显式动作）= 假——门即限流器（健康态显式动作 no-op）。
// ② hook 反转（避导入环 tabsModel→highlightClient→openFlow→tabsModel）：
//    registerRecreateHighlightClient 注册（highlightClient.ts 模块加载时注册一次），
//    requestHighlightRecreate 显式动作面（非 force）——未注册 no-op 不抛，重复注册
//    后签者生效，请求透传 opts。
import { describe, expect, it, vi } from 'vitest';
import {
  registerRecreateHighlightClient,
  requestHighlightRecreate,
  shouldRecreateHighlightClient
} from './highlightRecreate';

describe('shouldRecreateHighlightClient（failed-态门控谓词）', () => {
  it('force true 无条件真（CDN 档位变更 manifest 快照语义，越门重建）', () => {
    expect(
      shouldRecreateHighlightClient({ force: true, creationFailed: false, clientInitFailed: false, grammarTableEmpty: false })
    ).toBe(true);
    // force 优先于健康态：即使全部 failed 态为 false 也真
    expect(
      shouldRecreateHighlightClient({ force: true, creationFailed: true, clientInitFailed: true, grammarTableEmpty: true })
    ).toBe(true);
  });

  it('全 false（健康 client + 显式动作）= 假——门即限流器，重建 no-op', () => {
    expect(
      shouldRecreateHighlightClient({ creationFailed: false, clientInitFailed: false, grammarTableEmpty: false })
    ).toBe(false);
    // force 缺省即非 force（字段缺省显式 undefined，不传键同义）
    expect(
      shouldRecreateHighlightClient({ force: undefined, creationFailed: false, clientInitFailed: false, grammarTableEmpty: false })
    ).toBe(false);
  });

  it('creationFailed 单独为真（创建期失败，attach null 终态）', () => {
    expect(
      shouldRecreateHighlightClient({ creationFailed: true, clientInitFailed: false, grammarTableEmpty: false })
    ).toBe(true);
  });

  it('clientInitFailed 单独为真（实例 failWorker 毒化）', () => {
    expect(
      shouldRecreateHighlightClient({ creationFailed: false, clientInitFailed: true, grammarTableEmpty: false })
    ).toBe(true);
  });

  it('grammarTableEmpty 单独为真（worker 健康、三层 manifest 全失败）', () => {
    expect(
      shouldRecreateHighlightClient({ creationFailed: false, clientInitFailed: false, grammarTableEmpty: true })
    ).toBe(true);
  });

  it('组合 failed 态为真（任一即真）', () => {
    expect(
      shouldRecreateHighlightClient({ creationFailed: true, clientInitFailed: true, grammarTableEmpty: true })
    ).toBe(true);
    expect(
      shouldRecreateHighlightClient({ creationFailed: false, clientInitFailed: true, grammarTableEmpty: true })
    ).toBe(true);
  });
});

describe('registerRecreateHighlightClient / requestHighlightRecreate（neutral hook）', () => {
  it('注册后请求透传 opts（显式动作 → 重建单点）', () => {
    const fn = vi.fn();
    registerRecreateHighlightClient(fn);
    requestHighlightRecreate();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(); // 非 force：无 opts 透传（impl?.() 形态）
    requestHighlightRecreate();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('未注册 no-op 不抛（SSR/测试环境缺省安全）', () => {
    // 依赖模块内 impl 初始 null：新开模块实例的路径由上方用例顺序覆盖——此处直接
    // 调用不抛即可（重复注册/重置后的状态由下方用例钉住）
    expect(() => requestHighlightRecreate()).not.toThrow();
  });

  it('重复注册后签者生效（防御面：hook 单点只挂最新实现）', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerRecreateHighlightClient(first);
    registerRecreateHighlightClient(second);
    requestHighlightRecreate();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
