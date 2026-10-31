/**
 * iconTheme.svelte.ts — 图标主题运行时（图标主题 spec §3.2/§3.5，Task 3）。
 *
 * 职责：iconThemeState 单例（$state：sig 签名 / runtime 当前生效归一化主题 /
 * ready 首次应用完成旗标）+ applyIconsFromSettings（设置侧唯一应用入口：diff sig
 * → FontFace 注册/注销 + runtime 换装，无变化零操作；'none' → runtime null）+
 * setBuiltinIconThemeLoader（builtin 主题解析缝——Task 4 vendor Seti 后注册真实
 * 实现，本任务单测以 fake 注入）+ fontFamilyOf（per-definition fontId → 注册家族
 * 名映射，FileIcon 渲染消费）。
 *
 * sig 公式与订阅联动在 iconReaction.ts（纯 .ts，root vitest 可直测）——本模块为
 * runes 不可入 vitest（metaStore.test.ts 先例），运行时面（FontFace 装卸、换装）
 * 由 typecheck + e2e（Task 4 ICON-01..）覆盖。字体生命周期对齐 Review Focus：
 * 家族名带主题键防撞车（同一 ArrayBuffer 可重复注册不同名）、切换先 add 新后
 * delete 旧、注销按 FontFace 实例引用（document.fonts.delete）并 try/catch 包裹。
 */
import type { NormalizedIconTheme } from '@bhxch/vviewer-highlight';
import type { ImportedIconThemeFont } from './stores/session';
import { listIconThemes } from './stores/session';
import type { Settings } from './stores/settings';
import { iconSig } from './iconReaction';

/** 当前生效主题三元组：sig 供 iconReaction diff（初值 '' 保证首调必命中）；
 * runtime null = 无图标（'none' / 引用落空 / 加载失败回退）；ready = 首次
 * applyIconsFromSettings 完成过一次（e2e 轮询锚，运行中消费面无需读）。 */
export const iconThemeState = $state<{ sig: string; runtime: NormalizedIconTheme | null; ready: boolean }>({
  sig: '',
  runtime: null,
  ready: false
});

/**
 * builtin 图标主题 loader 缝（Task 4 注册 vendor Seti 真实实现）：按主题键返回
 * 归一化清单 + 字节（fonts 与 manifest.fonts 按序位对齐——builtin 清单由我方
 * vendor 侧产出，无路径关联歧义；导入通道则按 path 匹配，见下）。返回 null =
 * 该键无 builtin 主题（回退无图标）。
 */
export type BuiltinIconThemeLoader = (
  theme: string
) => Promise<{ manifest: NormalizedIconTheme; fonts: { data: ArrayBuffer }[] } | null>;

let builtinLoader: BuiltinIconThemeLoader | null = null;

export function setBuiltinIconThemeLoader(fn: BuiltinIconThemeLoader): void {
  builtinLoader = fn;
}

/** 已注册 FontFace 实例引用（document.fonts.delete 按实例注销，无按名注销 API）
 * 与所属主题键：applyIconsFromSettings 换装时同步翻新，恒等于 document.fonts 里的
 * 本运行时注册面。 */
let activeFaces: FontFace[] = [];
let activeThemeKey: string | null = null;

/** 注册家族名：首个字体裸用约定名 `vv-iconfont-<主题键>`（单字体主题即唯一名，
 * spec §3.2 字面口径）；多字体主题续 `-<序位>`（per-definition fontId 需可寻址的
 * 相异家族名，同族 FontFace 无法按 fontId 选择）。主题键 ∈ 'seti' | 'imported:<8位>'
 * ——白名单形态不含引号/反斜杠，CSS 引号包裹恒安全。 */
function iconFamilyName(themeKey: string, index: number): string {
  return index === 0 ? `vv-iconfont-${themeKey}` : `vv-iconfont-${themeKey}-${index}`;
}

/**
 * fontId → CSS font-family 值（FileIcon 消费，CSS-ready 已带双引号）：fontId 命中
 * runtime.fonts 取其注册序位，缺省/未知取第一个字体（单字体主题即唯一字体——
 * 绝大多数主题含 Seti 皆此形态）。runtime 未就绪返回 ''（调用方在 glyph 命中后才
 * 调用，正常不达）。
 */
export function fontFamilyOf(fontId?: string): string {
  if (activeThemeKey === null) return '';
  let index = 0;
  if (iconThemeState.runtime !== null && fontId !== undefined) {
    const hit = iconThemeState.runtime.fonts.findIndex((f) => f.id === fontId);
    if (hit >= 0) index = hit;
  }
  return `"${iconFamilyName(activeThemeKey, index)}"`;
}

/** 导入主题字体字节解析：manifest.fonts[].src 基名 ↔ 记录 path（T2 导入按基名
 * 关联，防 './' 前缀差异）逐 src 找首个命中记录；未命中的字体落 undefined（换装
 * 时 warn 跳过，不炸整体）。 */
function resolveImportedFontDatas(
  manifest: NormalizedIconTheme,
  records: ImportedIconThemeFont[]
): ({ data: ArrayBuffer } | undefined)[] {
  return manifest.fonts.map((meta) => {
    for (const src of meta.src) {
      const base = src.split('/').pop() ?? src;
      const hit = records.find((r) => r.path === base);
      if (hit !== undefined) return { data: hit.data };
    }
    return undefined;
  });
}

/**
 * FontFace 换装：新主题字体逐个 load（坏字体 warn 跳过不炸整体，fontsStore 先例）
 * → 先 add 新后 delete 旧（切换空窗期字形不闪回默认栈）→ 簿记翻新。manifest null
 * （'none'/引用落空）= 纯注销。delete 包 try/catch：对未注册/已注销实例与异常
 * document.fonts 实现按约安全。
 */
async function swapFaces(
  themeKey: string,
  manifest: NormalizedIconTheme | null,
  datas: readonly ({ data: ArrayBuffer } | undefined)[]
): Promise<void> {
  const faces: FontFace[] = [];
  if (manifest !== null) {
    for (let i = 0; i < manifest.fonts.length; i++) {
      const meta = manifest.fonts[i];
      if (meta === undefined) continue;
      const entry = datas[i];
      if (entry === undefined) {
        console.warn(`[icons] 主题「${manifest.name || themeKey}」字体 ${meta.id} 缺字节，该字体字形回退系统字体`);
        continue;
      }
      const descriptors: FontFaceDescriptors = {};
      if (meta.weight !== undefined) descriptors.weight = meta.weight;
      if (meta.style !== undefined) descriptors.style = meta.style;
      const face = new FontFace(iconFamilyName(themeKey, i), entry.data, descriptors);
      try {
        await face.load();
      } catch (err) {
        console.warn(`[icons] 字体 ${meta.id} 解析失败（内容不是有效字体？）`, err);
        continue;
      }
      faces.push(face);
    }
  }
  for (const face of faces) {
    try {
      document.fonts.add(face);
    } catch (err) {
      console.warn('[icons] FontFace 注册失败', err);
    }
  }
  const old = activeFaces;
  activeFaces = faces;
  for (const face of old) {
    try {
      document.fonts.delete(face);
    } catch {
      // 注销失败无害：孤儿 face 至多占用一份字体内存，不影响渲染正确性
    }
  }
  activeThemeKey = themeKey;
}

/** 'seti' 无 loader 仅告警一次（T4 接入前 reload 重复触发不刷屏）。 */
let warnedNoBuiltinLoader = false;

/** 应用串行链：字体装卸非幂等（add/delete 簿记），并发应用会交错换装——排队
 * 依次执行，末次设置最终生效；前序失败不阻塞后继。 */
let applyChain: Promise<void> = Promise.resolve();

/**
 * 设置侧唯一应用入口（AppShell onMount 首调 + onSettingsChanged 订阅链经
 * reactToIconsChange 消费；Task 5 更新覆盖写后亦可直调）：diff sig → 解析
 * manifest 与字体字节（imported 按 path 匹配 / builtin 走 loader）→ FontFace
 * 换装 → runtime 换装。无变化零操作（Review Focus）；失败 warn 不抛（签名未
 * 落位，后续变更自然重试），'none' 与引用落空均 runtime null。
 */
export function applyIconsFromSettings(s: Settings): Promise<void> {
  const run = async (): Promise<void> => {
    const sig = iconSig(s);
    if (sig === iconThemeState.sig) return;
    const themeKey = s.iconThemes.theme;
    let manifest: NormalizedIconTheme | null = null;
    let datas: readonly ({ data: ArrayBuffer } | undefined)[] = [];
    if (themeKey.startsWith('imported:')) {
      const rec = (await listIconThemes()).find((t) => t.id === themeKey) ?? null;
      if (rec !== null) {
        manifest = rec.manifest;
        datas = resolveImportedFontDatas(rec.manifest, rec.fonts);
      } else {
        // 引用回落语义（颜色主题同款）：记录已被删除，运行时降级无图标；设置槽
        // 回写 'none' 由删除流程负责
        console.warn(`[icons] 设置引用的图标主题不存在（已被删除？）：${themeKey}，回退无图标`);
      }
    } else if (themeKey === 'seti') {
      if (builtinLoader !== null) {
        const builtin = await builtinLoader(themeKey);
        if (builtin !== null) {
          manifest = builtin.manifest;
          datas = builtin.fonts;
        }
      } else if (!warnedNoBuiltinLoader) {
        warnedNoBuiltinLoader = true;
        console.warn('[icons] builtin 图标主题 loader 未注册（Seti 资产未接入，Task 4），回退无图标');
      }
    }
    // 'none' 与其余脏键：白名单已挡，此处 manifest 恒 null = 纯注销
    await swapFaces(themeKey, manifest, datas);
    iconThemeState.runtime = manifest;
    iconThemeState.sig = sig;
    iconThemeState.ready = true;
  };
  const next = applyChain.then(run, run);
  applyChain = next.catch(() => {}); // 链尾吞错：run 自不抛，防御意外同步异常毒化链
  return next;
}
