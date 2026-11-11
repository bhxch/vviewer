// saveAs.ts — 另存为统一管线（计划 2 Task 7，spec §6.4「另存为双形态 + tab 级动作」）。
// 三个消费面共用：进度卡完成态「另存为」、确认卡「下载并另存为」（ViewerPane tee 直写
// 路径，不走本模块——其 writable 须横跨整个 dispatch，见 ViewerPane 装配注释）、
// TabContextMenu 第七动作「另存为」（saveAsTab）。
//
// 取数路径（saveAsTab 三分；远端面残余 A2 起 picker-first）：
// - 在手/归档面（L1 FS Access 目录、L2 单文件、L3 zip 条目）：store.read(path) 单次
//   全量——L1/L2 File 字节在手、L3 经 zipStore（jszip entry.async）读全量，统一读
//   通道零分叉（zipStore read 的条目全量形态即「zip 条目 zipStore 读全量」），
//   字节到手 → saveAsBlob（picker 主/blob URL 兜底；读取即时，picker 在激活窗内）；
// - 远端面（R1/R2，isRemoteDownload 单源判定）：FS Access 环境 picker-first——
//   showSaveFilePicker 先选目标（首个 await，激活窗内）→ Task 6 确认门同规则
//   （超阈值先 hooks.confirm；size 未知不适用直接不定态下泵）→ pumpFull 分块泵
//   直写 writable（Task 2 导出单源）；无 FS Access 环境降级：确认门 → 取数全量 →
//   saveAsBlob（blob URL + `<a download>` 兜底）。
//
// 取舍备案（评审口径）：
// - saveAsTab 的远端路径是「重新取数」：完成后另存为/菜单另存为时字节已在渲染实例
//   内，但 core dispatch 只交付实例不交付字节（无取回缝，本批不动 core）——远端二次
//   传输为知情取舍；零重传形态 = 确认卡「下载并另存为」tee 直写（下载落盘一次完成）。
// - picker 瞬态激活窗（~5s）：saveAsTab 远端面已翻转为 picker-first（残余 A2）——
//   picker 先选目标（调用点 user gesture 激活窗内，本函数首个 await）→ 确认门 →
//   泵分块直写盘（saveAsStreamToDisk 形态：写失败 abort 半成品）；远端重下耗时
//   不再受激活窗约束。无 FS Access 环境降级现路径（确认门 → 取数全量 → saveAsBlob
//   blob URL 兜底）；在手/归档面（读取即时）维持原形态不经翻转。
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
// 纯层 i18n（Task 7 域 D）：文案调用时刻取当下 locale（非响应式），单源在目录键
import { translate as t } from './i18n/core';

export type SaveAsResult = 'saved' | 'cancelled' | 'denied';

/** NotAllowedError（picker 授权拒绝）的用户可见文案：TabBar 菜单路与 ViewerPane
 *  （完成态另存为 / 确认卡下载并另存为）三消费面单源，防双写漂移。原为常量
 *  SAVE_DENIED_NOTICE（Task 7 抽取改函数——目录键调用时刻取值，const 装载时刻
 *  锁定 locale 会破坏 en 态）。 */
export function saveDeniedNotice(): string {
  return t('viewer.save.denied');
}

/** saveAsTab 远端/取数失败的调用方提示文案（ViewerPane 完成态卡 catch 面）：与
 *  TabBar 菜单路 t('tabs.ctx.saveAsFailed') 同一目录键单源（同动作同文案，Task 4
 *  AppShell 侧重复串同键复用口径）——本包装供无 t() 导入的纯层消费面（遮蔽让位
 *  纪律，ViewerPane saveAsCompleted 局部 t 标识符不改名）。 */
export function saveAsFailedNotice(message: string): string {
  return t('tabs.ctx.saveAsFailed', { message });
}

/**
 * picker 关闭双语义拆分（此前 isPickerCancel 把两类都判取消 → 同为静默；但对用户
 * 不是一回事，静默面错置即「点了没反应」的真困惑）：
 * - AbortError = 用户主动关闭对话框 → isPickerCancel → 'cancelled' 静默（用户知道
 *   自己取消了，无需提示）；
 * - NotAllowedError = 浏览器拒绝（授权被策略拒/瞬态激活过期）→ isPickerDenied →
 *   'denied'，调用方上状态条提示（SAVE_DENIED_NOTICE）——用户没关任何对话框却回到
 *   原状。picker-first 翻转（残余 A2）后 FS Access 路的 picker 在手势内先弹、激活窗
 *   不是问题；但无 FS Access 降级路（saveAsTab 先取数后 saveAsBlob 选目标）取数耗时
 *   超激活窗时正是此形态——提示面要覆盖的就是它。
 * 双形态并列判定同 isAbortError 口径（jsdom 的 DOMException 不继承 Error，spec 形态）。
 */

/** 用户主动取消（AbortError 身份）：静默 cancelled */
function isPickerCancel(err: unknown): boolean {
  return isAbortError(err);
}

/** 浏览器拒绝（NotAllowedError 身份）：'denied' → 调用方状态条提示（不静默、不走兜底） */
export function isPickerDenied(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'NotAllowedError') ||
    (err instanceof Error && err.name === 'NotAllowedError')
  );
}

/** FS Access picker 在场探测（残余 A2 消费面）：saveAsTab 远端面据此分叉
 *  picker-first 形态/降级形态（saveAsBlob 内的同款探测独立在场，语义一致） */
function hasSaveFilePicker(): boolean {
  return (
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker ===
    'function'
  );
}

/** picker 调用（suggestedName 透传，saveAsBlob 主路同参形）：saveAsTab picker-first
 *  形态的目标选定期——调用点须保证本调用处于 user gesture 激活窗内（消费面均为
 *  点击处理器同步进入，本函数为 saveAsTab 首个 await） */
async function showSaveTarget(name: string): Promise<FileSystemFileHandle> {
  const w = window as unknown as {
    showSaveFilePicker: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  };
  return w.showSaveFilePicker({ suggestedName: name });
}

/**
 * blob 另存（spec §6.4「完成后另存为」字节落地面）：showSaveFilePicker（FS Access）
 * 为主——suggestedName 透传、blob 一次性写入 writable 后 close；AbortError →
 * 'cancelled' 静默（用户主动取消），NotAllowedError → 'denied'（浏览器拒绝：不静默
 * 也不降级兜底，交调用方状态条提示，见 isPickerDenied 注）。picker 缺席（无
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
      if (isPickerCancel(err)) return 'cancelled'; // 用户主动关对话框：静默
      if (isPickerDenied(err)) return 'denied'; // 浏览器拒绝：调用方提示面（不走兜底）
      // 非取消非拒绝的 picker 异常：降级兜底
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
 * 内存）。pump 抛错 → abort 丢弃半成品（临时文件不残留）且原错误上抛（写盘失败与
 * picker 判定互不混淆——writable.abort() 收口的 err 不进取消/拒绝分类）；picker
 * AbortError → 'cancelled'（pump 不启动）、NotAllowedError → 'denied'。
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
    throw new Error(t('viewer.save.noFsWrite'));
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await w.showSaveFilePicker({ suggestedName: name });
  } catch (err) {
    // picker 关闭双语义（见 isPickerCancel/isPickerDenied 注）：此处只分类 picker
    // 调用本身的 err；下方 pump/writable 的写盘失败走独立 catch 原样上抛，不进来
    if (isPickerCancel(err)) return 'cancelled';
    if (isPickerDenied(err)) return 'denied';
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
 * tab 另存为（spec §6.4 泛化为 tab 级动作）：远端面 picker-first（残余 A2：FS Access
 * 环境 picker 先选目标 → 确认门 → 泵直写盘；无 picker 降级取数全量 → saveAsBlob），
 * 在手/归档面（读取即时，saveAsBlob 内 picker 在激活窗内）取数全量 → saveAsBlob。
 * 占位/错误/目录 tab 的置灰判定在 saveAsDisabledOf（调用方在组装动作时过滤，本函数
 * 对不可读来源自然抛错由调用方 catch 上状态栏）。
 */
export async function saveAsTab(
  tab: SaveAsTabSource,
  hooks: SaveAsTabHooks = {}
): Promise<SaveAsResult> {
  const { source } = tab;
  const size =
    typeof source.size === 'number' && Number.isFinite(source.size) ? source.size : null;
  if (isRemoteDownload(source.storeId)) {
    const read = (range?: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> =>
      source.store.read(
        source.path,
        range !== undefined || signal !== undefined ? { range, signal } : undefined
      );
    // 残余 A2 picker-first 翻转（FS Access 环境）：远端拉取耗时不可控，「先泵后
    // picker」在重下超过 ~5s 瞬态激活窗时 showSaveFilePicker 被 NotAllowedError 拒
    // （'cancelled' 静默吞掉整个另存为）——翻转为「picker 先选目标（本函数首个
    // await，调用点 user gesture 激活窗内）→ 确认门 → 泵分块直写盘」
    // （saveAsStreamToDisk 形态：写失败 abort 半成品、原错误上抛由调用方状态条
    // 承接；盘 backed 流式直写不再全量驻留内存）。确认门拒绝 = cancelled（picker
    // 已选定不写盘，与「零读」同语义：目标文件零触碰）。
    if (hasSaveFilePicker()) {
      let handle: FileSystemFileHandle;
      try {
        handle = await showSaveTarget(source.name);
      } catch (err) {
        // picker 关闭双语义（见 isPickerCancel/isPickerDenied 注）：AbortError 静默、
        // NotAllowedError 'denied' 上调用方状态条；泵/写盘失败走下方独立 catch
        // （abort 半成品 + 原错误上抛），不进本分类
        if (isPickerCancel(err)) return 'cancelled';
        if (isPickerDenied(err)) return 'denied';
        throw err;
      }
      // 确认门（Task 6 同规则，阈值 settings 现值）：超阈值先 hooks.confirm；size
      // 未知不适用（无前置数字，直接不定态下泵）
      if (shouldConfirm(size, mbToBytes(loadSettings().storage.remoteDownloadConfirmMb))) {
        const ok =
          hooks.confirm === undefined
            ? true
            : await hooks.confirm({ name: source.name, sizeBytes: size! });
        if (!ok) return 'cancelled';
      }
      const writable = await handle.createWritable();
      try {
        if (source.store.rangeCapable === true) {
          // 泵分块直写（Task 2 同泵；I-2 门控同规则 rangeCapable 才走泵）——逐块
          // await 写盘保序，进度同 Task 2 ReadProgressEvent 平面；写失败上抛由
          // 下方 abort 收口（与 saveAsStreamToDisk 同语义）
          await pumpFull(
            async (range, sig) => {
              const chunk = await read(range, sig);
              await writable.write(chunk);
              return chunk;
            },
            size,
            hooks.signal,
            (p) => hooks.onProgress?.(p)
          );
        } else {
          // 泵门控（终审修复波 I-2，dispatcher readFull 同款）：非 range 来源
          //（directS3/directDav Range 防线降级 rangeOk=false）带窗 read 退化为整对象
          // 下载再切片，泵的 N 窗循环会把传输放大 N 倍——回落单次全量 read（signal
          // 贯穿保留取消面）+ 单条 100% 进度上报（进度卡直上完成态）；整块一次写盘
          const bytes = await source.store.read(
            source.path,
            hooks.signal !== undefined ? { signal: hooks.signal } : undefined
          );
          await writable.write(bytes);
          hooks.onProgress?.({ loaded: bytes.length, total: bytes.length });
        }
        await writable.close();
        return 'saved';
      } catch (err) {
        await writable.abort().catch(() => {}); // 半成品丢弃，不让临时文件残留
        throw err;
      }
    }
    // 无 FS Access 环境（降级现路径）：确认门（Task 6 同规则）→ 取数全量 →
    // saveAsBlob（picker 缺席 = blob URL + `<a download>` 兜底）
    if (shouldConfirm(size, mbToBytes(loadSettings().storage.remoteDownloadConfirmMb))) {
      const ok =
        hooks.confirm === undefined
          ? true
          : await hooks.confirm({ name: source.name, sizeBytes: size! });
      if (!ok) return 'cancelled';
    }
    let bytes: Uint8Array<ArrayBuffer>;
    if (source.store.rangeCapable === true) {
      bytes = await pumpFull(read, size, hooks.signal, (p) => hooks.onProgress?.(p));
    } else {
      // 泵门控（I-2）：形态同上 picker 分支——单次全量 read + 单条 100% 上报
      bytes = await source.store.read(
        source.path,
        hooks.signal !== undefined ? { signal: hooks.signal } : undefined
      );
      hooks.onProgress?.({ loaded: bytes.length, total: bytes.length });
    }
    return saveAsBlob(new Blob([bytes]), source.name);
  }
  // 在手/归档面（L1–L3）：store.read 单次全量——L1/L2 File 字节在手、L3 zipStore
  // 条目读全量（jszip entry.async），统一读通道（读取即时，saveAsBlob 内 picker
  // 处于激活窗内，无 A2 翻转面）
  const bytes = await source.store.read(source.path);
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
