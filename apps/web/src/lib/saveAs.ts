// saveAs.ts — 另存为统一管线（计划 2 Task 7，spec §6.4「另存为双形态 + tab 级动作」）。
// 三个消费面共用：进度卡完成态「另存为」、确认卡「下载并另存为」（ViewerPane tee 直写
// 路径，不走本模块——其 writable 须横跨整个 dispatch，见 ViewerPane 装配注释）、
// TabContextMenu 第七动作「另存为」（saveAsTab）。
//
// 取数路径（saveAsTab 三分）：
// - 在手/归档面（L1 FS Access 目录、L2 单文件、L3 zip 条目）：store.read(path) 单次
//   全量——L1/L2 File 字节在手、L3 经 zipStore（jszip entry.async）读全量，统一读
//   通道零分叉（zipStore read 的条目全量形态即「zip 条目 zipStore 读全量」）；
// - 远端面（R1/R2，isRemoteDownload 单源判定）：pumpFull 分块泵（Task 2 导出单源）
//   + Task 6 确认门同规则（超阈值先 hooks.confirm；size 未知不适用直接不定态下泵）；
// 字节到手 → saveAsBlob（picker 主/blob URL 兜底）。
//
// 取舍备案（评审口径）：
// - saveAsTab 的远端路径是「重新取数」：完成后另存为/菜单另存为时字节已在渲染实例
//   内，但 core dispatch 只交付实例不交付字节（无取回缝，本批不动 core）——远端二次
//   传输为知情取舍；零重传形态 = 确认卡「下载并另存为」tee 直写（下载落盘一次完成）。
// - picker 瞬态激活窗（~5s）：saveAsTab 为「先泵后 picker」形态——菜单与完成态两条
//   路径同受影响，远端重下耗时超过激活窗时 showSaveFilePicker 抛 NotAllowedError →
//   'cancelled' 静默（saveAsBlob 取消语义）；消解需翻转为「picker 先选、泵后写」
//   （pumpToWritable 已具备该形态的字节面，接线留后续）。
// - 确认门在 saveAsTab 内以 hooks.confirm 呈现（本模块无 UI 依赖，纯 .ts vitest 直测）：
//   TabBar 菜单传 window.confirm、完成态卡传恒真（已下载过一次知情）；钩子缺省放行
//   （无确认面的调用方，门语义由调用方裁决）。
// - saveAsStreamToDisk 为接口契约面（brief Produces）：picker + writable 生命周期
//   （close 收口/abort 清偿半成品）+ getFile 回填由 pump 闭包承担的盘 backed File
//   交还模式；本批应用内暂无消费者（ViewerPane tee 因 dispatch 同步渲染需求自带
//   writable 装配），留计划 3 桥接大文件流式落盘复用。
import {
  isAbortError,
  pumpFull,
  type ByteRange,
  type FileSource,
  type ReadProgressEvent
} from '@bhxch/vviewer-core';
import { mbToBytes, shouldConfirm } from './downloadConfirm';
import { isRemoteDownload } from './downloadProgress';
import { loadSettings } from './stores/settings';

export type SaveAsResult = 'saved' | 'cancelled';

/** picker 取消/授权拒绝的静默分类（brief：NotAllowedError/AbortError → 'cancelled'
 *  静默；其余错误交由调用方面） */
function isPickerCancel(err: unknown): boolean {
  return (
    isAbortError(err) ||
    // jsdom 的 DOMException 不继承 Error（spec 形态）：NotAllowedError 双形态并列判定
    (err instanceof DOMException && err.name === 'NotAllowedError') ||
    (err instanceof Error && err.name === 'NotAllowedError')
  );
}

/**
 * blob 另存（spec §6.4「完成后另存为」字节落地面）：showSaveFilePicker（FS Access）
 * 为主——suggestedName 透传、blob 一次性写入 writable 后 close；NotAllowedError/
 * AbortError → 'cancelled' 静默（用户取消与授权拒绝不是错误）。picker 缺席（无
 * FS Access 环境，SHELL-07 同域）或 picker 后写入失败 → blob URL + `<a download>`
 * 点击兜底（revoke 延迟 30s 覆盖下载启动窗）。
 */
export async function saveAsBlob(blob: Blob, suggestedName: string): Promise<SaveAsResult> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName });
      let writable: FileSystemWritableFileStream | null = null;
      try {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'saved';
      } catch {
        // 终审修复波 M-5：兜底前中止半成品（abort 丢弃临时文件，.crswap 不残留）；
        // createWritable 自身失败（句柄失效）时无可 abort 面，直接落下方兜底
        if (writable !== null) await writable.abort().catch(() => {});
        // picker 成功后的写盘失败（磁盘满/权限回收）：降级 blob URL 兜底，数据不丢
      }
    } catch (err) {
      if (isPickerCancel(err)) return 'cancelled';
      // 非取消的 picker 异常（瞬时激活失效等）：降级兜底
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'saved';
}

/**
 * 流式直写盘（spec §6.4「下载并另存为」的管线形态）：picker 选定句柄 → createWritable
 * → pump 闭包分块直写（进度/取消由 pump 自持）→ 管线 close 收口落盘 → pump 返回
 * handle.getFile() 回填的盘 backed File（供调用方交渲染器复用，渲染器无需全量驻留
 * 内存）。pump 抛错 → abort 丢弃半成品（临时文件不残留）且原错误上抛；picker 取消
 * → 'cancelled'（pump 不启动）。
 */
export async function saveAsStreamToDisk(
  source: FileSource,
  name: string,
  pump: (writable: FileSystemWritableFileStream) => Promise<File>
): Promise<SaveAsResult> {
  void source; // 契约形参（brief 签名）：per-source 分支预留，当前取数职责在 pump 闭包
  const w = window as unknown as {
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  };
  if (typeof w.showSaveFilePicker !== 'function') {
    throw new Error('当前环境不支持文件句柄直写（无 showSaveFilePicker）');
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await w.showSaveFilePicker({ suggestedName: name });
  } catch (err) {
    if (isPickerCancel(err)) return 'cancelled';
    throw err;
  }
  const writable = await handle.createWritable();
  try {
    await pump(writable);
    await writable.close();
    return 'saved';
  } catch (err) {
    await writable.abort().catch(() => {}); // 半成品丢弃，不让临时文件残留
    throw err;
  }
}

/**
 * 自持泵 tee 落盘单源（评审 M-1，「下载并另存为」的字节面保证）：tee 严格限定本泵
 * 通道——dispatch 内部读（headOnly 的 8KB 探测窗、streaming 渲染器的按需窗）不进
 * tee，探测前缀重复/乱序窗写盘的坏文件面消除。逐块直写 writable（泵逐块 await
 * read，顺序写天然保序），写失败置位 writeFailed 不回灌取数主路（字节流照常交付，
 * 收口 close/abort 由调用方按 flag 裁决）；返回全量 buffer 供 dispatch buffer 直传
 * （full = buffer 零重读，progress 经 onProgress 与 dispatch 泵同节奏上报）。
 */
export async function pumpToWritable(
  read: (range?: ByteRange, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>,
  size: number | null,
  writable: FileSystemWritableFileStream,
  onProgress?: (p: ReadProgressEvent) => void,
  signal?: AbortSignal
): Promise<{ buffer: Uint8Array<ArrayBuffer>; writeFailed: boolean }> {
  let writeFailed = false;
  const buffer = await pumpFull(
    async (range, sig) => {
      const chunk = await read(range, sig);
      try {
        await writable.write(chunk);
      } catch {
        writeFailed = true; // 盘面失败吞掉置位：渲染主路优先，半成品交调用方收口
      }
      return chunk;
    },
    size,
    signal,
    (p) => onProgress?.(p)
  );
  return { buffer, writeFailed };
}

// ---------- saveAsTab（tab 级统一入口：取数三分 + 确认门 → saveAsBlob） ----------

export interface SaveAsTabSource {
  source: FileSource;
}

export interface SaveAsConfirmInfo {
  name: string;
  sizeBytes: number;
}

export interface SaveAsTabHooks {
  /** 远端超阈值确认门（Task 6 同规则：total > settings 阈值时先确认后泵）；
   * false = 取消整个另存为。size 未知不适用（不问即直取）。 */
  confirm?(info: SaveAsConfirmInfo): boolean | Promise<boolean>;
  /** 远端泵进度（Task 2 ReadProgressEvent 平面）：菜单/完成态路径的进度上报钩子 */
  onProgress?(p: ReadProgressEvent): void;
  /** 取消信号：贯穿每次 range 读（store 原生 abort reject） */
  signal?: AbortSignal;
}

/**
 * tab 另存为（spec §6.4 泛化为 tab 级动作）：ensure 全量字节（三分路径见文件头）→
 * saveAsBlob。占位/错误/目录 tab 的置灰判定在 saveAsDisabledOf（调用方在组装动作
 * 时过滤，本函数对不可读来源自然抛错由调用方 catch 上状态栏）。
 */
export async function saveAsTab(
  tab: SaveAsTabSource,
  hooks: SaveAsTabHooks = {}
): Promise<SaveAsResult> {
  const { source } = tab;
  const size =
    typeof source.size === 'number' && Number.isFinite(source.size) ? source.size : null;
  let bytes: Uint8Array<ArrayBuffer>;
  if (isRemoteDownload(source.storeId)) {
    // 确认门（Task 6 同规则，阈值 settings 现值）：超阈值先 hooks.confirm；size 未知
    // 不适用（无前置数字，直接不定态下泵）
    if (shouldConfirm(size, mbToBytes(loadSettings().storage.remoteDownloadConfirmMb))) {
      const ok =
        hooks.confirm === undefined ? true : await hooks.confirm({ name: source.name, sizeBytes: size! });
      if (!ok) return 'cancelled';
    }
    const read = (range?: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> =>
      source.store.read(
        source.path,
        range !== undefined || signal !== undefined ? { range, signal } : undefined
      );
    if (source.store.rangeCapable === true) {
      bytes = await pumpFull(read, size, hooks.signal, (p) => hooks.onProgress?.(p));
    } else {
      // 泵门控（终审修复波 I-2，dispatcher readFull 同款）：非 range 来源
      //（directS3/directDav Range 防线降级 rangeOk=false）带窗 read 退化为整对象
      // 下载再切片，泵的 N 窗循环会把传输放大 N 倍——回落单次全量 read（signal
      // 贯穿保留取消面）+ 单条 100% 进度上报（进度卡直上完成态）
      bytes = await source.store.read(
        source.path,
        hooks.signal !== undefined ? { signal: hooks.signal } : undefined
      );
      hooks.onProgress?.({ loaded: bytes.length, total: bytes.length });
    }
  } else {
    // 在手/归档面（L1–L3）：store.read 单次全量——L1/L2 File 字节在手、L3 zipStore
    // 条目读全量（jszip entry.async），统一读通道
    bytes = await source.store.read(source.path);
  }
  return saveAsBlob(new Blob([bytes]), source.name);
}

// ---------- 第七动作置灰判定（brief「tabsModel 层：占位/错误 tab 返回 disabled」，
// 落位本纯模块供 vitest 直测；TabBar ctxActions 组装时消费） ----------

/** 另存为置灰结构面（Tab 的最小形状——纯函数不依赖 runes 域模块） */
export interface SaveAsDisabledTabLike {
  unrestorable?: boolean;
  /** ViewerPane 渲染 effect 成功路径写入：错误卡片 dispatch 的 rendererId 恒 'error' */
  lastRendererId?: string;
  source: { path: string };
}

/**
 * 「另存为」第七动作置灰（spec §6.4：占位/错误 tab 置灰）：unrestorable（会话恢复
 * 占位，内容不可重建）、lastRendererId 'error'（渲染失败错误卡片 tab）、目录 tab
 * （path ''，无文件可存）为 disabled；pinned/未渲染（lastRendererId 缺省）不置灰。
 */
export function saveAsDisabledOf(tab: SaveAsDisabledTabLike): boolean {
  return tab.unrestorable === true || tab.source.path === '' || tab.lastRendererId === 'error';
}
