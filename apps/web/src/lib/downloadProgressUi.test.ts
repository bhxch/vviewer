// downloadProgressUi.test.ts — 下载进度卡 UI（计划 2 Task 4，spec §6.4）。
// 根 vitest 无 svelte 插件（metaStore.test.ts / exportPanel.test.ts 同款约束）：
// .svelte 组件与 ViewerPane 不可挂载——纯逻辑（快照行文案/地址拼装/远端来源门）在
// downloadProgress.ts 直测；组件与 ViewerPane 接线按既有「源码契约断言」先例
// （settingsCenter.test.ts / mountsManagerUi.test.ts / exportPanel.test.ts 同形态）
// 锁定字段、取消链路与生命周期锚；运行时行为由 e2e 兜底。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createProgressTracker,
  dlAddressText,
  dlLoadedLine,
  isRemoteDownload,
  type ProgressSnapshot
} from './downloadProgress';
import { displayEndpointForStore, resetMountRecordCacheForTests, saveDirectMount, type DirectMountRecord } from './mountsSync';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

function snap(o: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    loadedText: '2.0 MB',
    totalText: '10.0 MB',
    speedText: '1.0 MB/s',
    etaText: '8 秒',
    ratio: 0.2,
    ...o
  };
}

// ---------- 纯逻辑：卡片行文案 / 地址拼装 / 远端来源门（downloadProgress.ts 直测） ----------

describe('dlLoadedLine（已下载行：total 已知/不定态双形态，spec §6.4）', () => {
  it('total 已知：「已下载 N / M」（已下载/完整大小同 行）', () => {
    expect(dlLoadedLine(snap())).toBe('已下载 2.0 MB / 10.0 MB');
  });

  it('不定态（totalText null）：「已下载 N（总大小未知）」——T3 移交的拼装面', () => {
    expect(dlLoadedLine(snap({ totalText: null, ratio: null, etaText: null }))).toBe(
      '已下载 2.0 MB（总大小未知）'
    );
  });
});

describe('dlAddressText（地址行：脱敏 display endpoint + path）', () => {
  it('userinfo 剥除（displayEndpoint 单源）+ 尾斜杠归一 + 斜杠拼接', () => {
    expect(dlAddressText('https://user:pass@dav.example.com/dav/', 'docs/report.pdf')).toBe(
      'https://dav.example.com/dav/docs/report.pdf'
    );
  });

  it('path 前导斜杠不双拼；endpoint 缺席（记录未列出/本地源）退化为 path 本体', () => {
    expect(dlAddressText('https://dav.example.com', '/a/b.md')).toBe('https://dav.example.com/a/b.md');
    expect(dlAddressText(null, 'a/b.md')).toBe('a/b.md');
    expect(dlAddressText(undefined, 'a/b.md')).toBe('a/b.md');
  });
});

describe('isRemoteDownload（进度卡门：仅远端来源显示进度卡/经泵，spec §6.4 R1/R2）', () => {
  it('R1 服务端（remote:）与 R2 直连（s3direct:/davdirect:）为真', () => {
    expect(isRemoteDownload('remote:abcd1234')).toBe(true);
    expect(isRemoteDownload('remote:abcd1234:r2:ef567890')).toBe(true);
    expect(isRemoteDownload('s3direct:abcd1234')).toBe(true);
    expect(isRemoteDownload('davdirect:abcd1234')).toBe(true);
  });

  it('本地/归档/URL 通道为假（L1–L3 不显示进度卡不受确认门；url: 泵 Range 请求不被 url store 支持，维持 v1）', () => {
    expect(isRemoteDownload('localfs:docs')).toBe(false);
    expect(isRemoteDownload('localfiles:w1')).toBe(false);
    expect(isRemoteDownload('single:f.txt:12:1700')).toBe(false);
    expect(isRemoteDownload('zip:a.zip')).toBe(false);
    expect(isRemoteDownload('url:abcd1234')).toBe(false);
  });
});

describe('进度卡三帧数据流（不定态→有 total→速度稳）：tracker 快照逐帧驱动卡片文案形态', () => {
  const MB = 1024 * 1024;
  it('帧1 不定态（只显已下载）→ 帧2 有 total（速度未稳「计算中」）→ 帧3 速度/ETA 稳', () => {
    let t = 0;
    const frames: ProgressSnapshot[] = [];
    const tracker = createProgressTracker((s) => frames.push(s), { now: () => t, throttleMs: 0 });
    tracker.update(1, null); // 帧1：total 未上报
    t = 500;
    tracker.update(2 * MB, 10 * MB); // 帧2：total 到达（跨度 <1s 速度未稳）
    t = 5000;
    tracker.update(4 * MB, 10 * MB); // 帧3：滑窗 ≥1s 速度稳

    expect(frames.length).toBe(3);
    // 帧1：不定态——ratio/speed/eta 全 null，卡片文案走「（总大小未知）」括注
    expect(frames[0]!.totalText).toBeNull();
    expect(frames[0]!.ratio).toBeNull();
    expect(frames[0]!.speedText).toBeNull();
    expect(frames[0]!.etaText).toBeNull();
    expect(dlLoadedLine(frames[0]!)).toBe('已下载 1 B（总大小未知）');
    // 帧2：有 total——ratio 进度条驱动、速度行隐藏、ETA 占位「计算中」
    expect(frames[1]!.totalText).toBe('10.0 MB');
    expect(frames[1]!.ratio).toBeCloseTo(0.2);
    expect(frames[1]!.speedText).toBeNull();
    expect(frames[1]!.etaText).toBe('计算中');
    expect(dlLoadedLine(frames[1]!)).toBe('已下载 2.0 MB / 10.0 MB');
    // 帧3：速度稳——速度行/ETA 数字就位（数值精度归 T3，本层只锚形态）
    expect(frames[2]!.speedText).not.toBeNull();
    expect(frames[2]!.etaText).not.toBeNull();
    expect(frames[2]!.etaText).not.toBe('计算中');
  });
});

// ---------- 组件契约：DownloadProgressCard.svelte（字段/不定态/取消回调） ----------

describe('DownloadProgressCard 骨架（spec §6.4 字段全锚）', () => {
  const src = readSrc('src/lib/DownloadProgressCard.svelte');

  it('props：snapshot（可空，完成态分支不消费）+ address + oncancel（取消经回调上抛，组件不持 AbortController）', () => {
    expect(src).toMatch(/snapshot: ProgressSnapshot \| null/);
    expect(src).toMatch(/address\?: string/);
    expect(src).toMatch(/oncancel: \(\) => void/);
  });

  it('字段全锚：地址行/进度条（ratio 宽度）/已下载行（dlLoadedLine）/速度/ETA/取消钮', () => {
    expect(src).toMatch(/vv-dl-progress-address/);
    expect(src).toMatch(/vv-dl-progress-fill/);
    expect(src).toMatch(/style:width/);
    expect(src).toMatch(/\{dlLoadedLine\(snapshot\)\}/);
    expect(src).toMatch(/snapshot\.speedText/);
    expect(src).toMatch(/snapshot\.etaText/);
    expect(src).toContain('>取消</button>');
    expect(src).toMatch(/onclick=\{oncancel\}/);
  });

  it('不定态：ratio null → 进度条 indeterminate 修饰类、fill 不渲染；speed/eta 行按 null 隐藏', () => {
    expect(src).toMatch(/snapshot\.ratio === null/);
    expect(src).toMatch(/vv-dl-progress-bar-indeterminate/);
    expect(src).toMatch(/\{#if snapshot\.ratio !== null\}/);
    expect(src).toMatch(/\{#if snapshot\.speedText !== null\}/);
    expect(src).toMatch(/\{#if snapshot\.etaText !== null\}/);
  });

  it('status 语义（读屏可达）：容器 role="status"', () => {
    expect(src).toMatch(/role="status"/);
  });

  it('ETA 文案形态（评审 M-4）：未稳「计算中」不带「剩余」前缀，真实 ETA 保持「剩余 X」', () => {
    expect(src).toMatch(/ETA_PENDING_TEXT/);
    expect(src).toMatch(/`剩余 \$\{snapshot\.etaText\}`/);
  });

  it('进度条读屏可达（评审 M-5）：role=progressbar + valuemin/max 恒挂，valuenow 仅定态（不定态省略）', () => {
    expect(src).toMatch(/role="progressbar"/);
    expect(src).toMatch(/aria-valuemin="0"/);
    expect(src).toMatch(/aria-valuemax="100"/);
    expect(src).toMatch(/aria-valuenow=\{snapshot\.ratio === null \? undefined :/);
  });
});

// ---------- 组件契约：DownloadProgressCard 完成态（计划 2 Task 7，spec §6.4「完成后另存为」） ----------

describe('DownloadProgressCard 完成态骨架（Task 7 双动作之一）', () => {
  const src = readSrc('src/lib/DownloadProgressCard.svelte');

  it('done 形态：标题「下载完成」+ 文件名/总大小 + 另存为/关闭双动作（onsaveas/onclose 上抛）', () => {
    expect(src).toMatch(/vv-dl-progress-done/);
    expect(src).toContain('下载完成');
    expect(src).toMatch(/done\.name/);
    expect(src).toMatch(/\{#if done\.totalText !== null\}/);
    expect(src).toContain('>另存为</button>');
    expect(src).toContain('>关闭</button>');
    expect(src).toMatch(/onclick=\{onsaveas\}/);
    expect(src).toMatch(/onclick=\{onclose\}/);
  });

  it('形态互斥：done 非 null 走完成态分支，snapshot 行（进度条/取消钮）仅在下载中分支', () => {
    expect(src).toMatch(/\{#if done !== null\}/);
    // 下载中形态在 {:else if snapshot !== null} 分支：完成态不渲染进度条/取消
    expect(src).toMatch(/\{:else if snapshot !== null\}/);
  });
});

// ---------- 接线契约：ViewerPane（装配门/取消链路/生命周期锚） ----------

describe('ViewerPane 进度卡接线（计划 2 Task 4）', () => {
  const src = readSrc('src/lib/ViewerPane.svelte');

  it('装配门：仅远端来源（isRemoteDownload）建 tracker 并传 onReadProgress，本地来源零感知', () => {
    expect(src).toMatch(/import \{[^}]*createProgressTracker[^}]*\} from '\.\/downloadProgress'/);
    expect(src).toMatch(/isRemoteDownload\(current\.source\.storeId\)/);
    expect(src).toMatch(/onReadProgress: \(p: ReadProgressEvent\) => tracker\.update\(p\.loaded, p\.total\)/);
  });

  it('地址行装配：getRemoteBase（R1）缺席回落 displayEndpointForStore（R2 记录镜像），经 dlAddressText 拼装', () => {
    expect(src).toMatch(/getRemoteBase\(current\.source\.storeId\)/);
    expect(src).toMatch(/displayEndpointForStore\(current\.source\.storeId\)/);
    expect(src).toMatch(/dlAddressText\(/);
  });

  it('取消链路：取消柄 dlAbort = effectAbort（同 dispatch signal 源）；cancelDownload abort + 卸卡', () => {
    expect(src).toMatch(/dlAbort = effectAbort/);
    expect(src).toMatch(/function cancelDownload\(\): void \{[\s\S]{0,200}dlAbort\?\.abort\(\)/);
    expect(src).toMatch(/function cancelDownload\(\): void \{[\s\S]{0,80}dlProgress = null/);
  });

  it('完成让位：dispatch resolve 后先卸卡再接管 host（live = res.instance 前清 dlProgress；Task 7 tee 收口/完成态卡居间，窗口放宽）', () => {
    expect(src).toMatch(/dlProgress = null;[\s\S]{0,900}live = res\.instance/);
  });

  it('abort 静默面：resolve 守卫扩 effectAbort.signal.aborted（取消钮路径的 no-op 实例丢弃）；catch 先卸卡再分流', () => {
    expect(src).toMatch(/if \(cancelled \|\| effectAbort\.signal\.aborted\) \{/);
    expect(src).toMatch(/catch \(err\) \{[\s\S]{0,500}dlProgress = null;[\s\S]{0,800}isAbortError\(err\)/);
  });

  it('abort 残卡防御（评审 M-3）：abort 收场分支与完成态同生命周期——卸卡 + 清地址行', () => {
    expect(src).toMatch(
      /if \(cancelled \|\| effectAbort\.signal\.aborted\) \{[\s\S]{0,240}dlProgress = null;[\s\S]{0,80}dlAddress = '';/
    );
  });

  it('生命周期清偿：cleanup 卸卡 + 清取消柄（abort 竞态锚——tab 切换/重渲染不留孤儿卡）', () => {
    expect(src).toMatch(/dlProgress = null; \/\/ 进度卡随[\s\S]{0,80}清偿/);
    expect(src).toMatch(/dlAbort = null/);
  });

  it('模板挂载：加载态区 pane 级浮层（SearchPanel 同锚，host 外侧）渲染卡片，props 三件套接线', () => {
    // 浮层置于 .vv-viewer-scroll 之后的 pane 层（host 子内容由 dispatch replaceChildren
    // 接管，Svelte 管理的卡不放 host 内；不占流式布局——下载中不出滚动条）
    expect(src).toMatch(/<\/div>\s*\{#if dlProgress\}[\s\S]{0,400}<DownloadProgressCard/);
    expect(src).toMatch(/snapshot=\{dlProgress\}/);
    expect(src).toMatch(/address=\{dlAddress\}/);
    expect(src).toMatch(/oncancel=\{cancelDownload\}/);
  });
});

// ---------- 接线契约：ViewerPane 另存为（计划 2 Task 7，spec §6.4 双形态） ----------

describe('ViewerPane 另存为接线（Task 7）', () => {
  const src = readSrc('src/lib/ViewerPane.svelte');

  it('完成态卡装配：远端 tracker 在场才装（本地零感知），TTL 定时自动卸载；cleanup/守卫分支双路清偿', () => {
    expect(src).toMatch(/if \(tracker !== null\) \{[\s\S]{0,200}dlDone = \{/);
    expect(src).toMatch(/DL_DONE_TTL_MS/);
    expect(src).toMatch(/function clearDlDone\(\): void \{[\s\S]{0,160}dlDone = null;/);
    expect(src).toMatch(/clearDlDone\(\); \/\/ 完成态卡随 effect 清偿卸载/);
  });

  it('「下载并另存为」tee：确认卡次动作句柄键比对消费（跨 tab 误配丢弃），read 闭包直写 writable（写失败不回灌渲染）', () => {
    expect(src).toMatch(/dlSaveHandle = \{ key, handle \}/);
    expect(src).toMatch(/savePick\.key === dlKey \? savePick\.handle : null/);
    expect(src).toMatch(/await saveHandle\.createWritable\(\)\.catch\(\(\) => null\)/);
    expect(src).toMatch(/await w\.write\(chunk\)/);
    expect(src).toMatch(/saveWriteFailed = true;/);
    // 收口三路：成功 close / abort 半成品 / cleanup abort
    expect(src).toMatch(/if \(saveWriteFailed\) void w\.abort\(\)\.catch\(\(\) => \{\}\);/);
    expect(src).toMatch(/else void w\.close\(\)\.catch\(\(\) => \{\}\);/);
  });

  it('完成态「另存为」走 saveAsTab 统一管线（确认门自动放行——已下载过一次）；失败上状态栏', () => {
    expect(src).toMatch(/await saveAsTab\(t, \{ confirm: \(\) => true \}\)/);
    expect(src).toMatch(/showStatusNotice\(`另存为失败：/);
  });

  it('模板双分支：进度卡（dlProgress）/完成态卡（dlDone）互斥；确认卡 onsaveas 仅 FS Access 可用环境装配', () => {
    expect(src).toMatch(/\{:else if dlDone\}/);
    expect(src).toMatch(/onsaveas=\{canFsSave \? \(\) => void confirmSaveAsDownload\(\) : undefined\}/);
    expect(src).toMatch(
      /typeof \(window as unknown as \{ showSaveFilePicker\?: unknown \}\)\.showSaveFilePicker === 'function'/
    );
  });
});

// ---------- 地址行远端 endpoint 单源：mountsSync.displayEndpointForStore ----------

describe('displayEndpointForStore（进度卡地址的 R2 直连 endpoint 镜像）', () => {
  function directOf(overrides: Partial<DirectMountRecord> = {}): DirectMountRecord {
    return {
      id: 's3direct:abcd1234',
      kind: 'direct',
      backend: 's3',
      label: '直连桶',
      endpoint: 'https://ak:secret@s3.example.com',
      bucket: 'b1',
      prefix: '',
      username: 'ak',
      secret: 'sk',
      pathStyle: true,
      createdAt: 1700000000001,
      ...overrides
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMountRecordCacheForTests();
  });

  it('direct 精确命中：返回脱敏 endpoint（displayEndpoint 单源剥 userinfo）', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await saveDirectMount(directOf());
    expect(displayEndpointForStore('s3direct:abcd1234')).toBe('https://s3.example.com');
  });

  it('未命中（未列出/非 direct id）undefined——调用方回落 path-only 显示（降级安全）', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await saveDirectMount(directOf());
    expect(displayEndpointForStore('s3direct:ffffffff')).toBeUndefined();
    expect(displayEndpointForStore('remote:abcd1234')).toBeUndefined();
  });
});
