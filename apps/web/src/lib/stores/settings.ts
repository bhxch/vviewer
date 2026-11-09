import type { ComputePolicy } from '@bhxch/vviewer-core';
import { resolveDiagramType, type DiagramMode } from '@bhxch/vviewer-render-diagram';
import { MERMAID_THEMES, type MermaidTheme } from '@bhxch/vviewer-render-diagram';
import { DEFAULT_LAYOUT, sanitizeLayout, type LayoutSettings } from '../layout';

/** mermaid 主题设置白名单（spec 2026-10-23 §9.2）：'auto' 跟随外观亮暗（现状语义，
 * 消费侧 viewer.ts 注入器/AppShell 派发经 resolveMermaidTheme 解析），其余为 mermaid
 * 原生主题显式固定。 */
export const MERMAID_THEME_VALUES: readonly (MermaidTheme | 'auto')[] = ['auto', ...MERMAID_THEMES];

/** 图表渲染设置（spec 2026-10-19 §2.1）：krokiHost 空串 = 用注册表 DEFAULT_KROKI_HOST；
 * modes 键 = 图表类型 id/别名，值覆盖注册表 defaultMode（Task 7 面板消费）；
 * krokiVia 为 kroki 消费通道（spec 2026-10-23 §8.3）：client=前端直连 kroki img，
 * server=经部署侧 /api/kroki 代发（能力缺失时管线自动回落 client）；
 * renderers 键 = 图表类型 id，值 = 本地渲染器覆盖（spec 2026-10-23 §9.1，仅注册表
 * 宣告 renderers 的类型——graphviz: viz-js/hpcc；空/未命中 = 注册表默认 viz-js）；
 * mermaidTheme 为 mermaid 主题（spec 2026-10-23 §9.2）：'auto'=跟随外观亮暗。 */
export interface DiagramsSettings {
  krokiHost: string;
  krokiVia: 'client' | 'server';
  mermaidTheme: 'auto' | MermaidTheme;
  modes: Record<string, DiagramMode>;
  renderers: Record<string, string>;
}

/** 字体设置（spec 2026-10-19 字体系统 §2.1）：family '' = 默认栈；字号 px，
 * clamp 范围见 UI_SIZE_RANGE/CODE_SIZE_RANGE。双槽语义：ui* 作用于 body 继承面，
 * code* 作用于 .vv-code-pre/.vv-hex-dump。 */
export interface FontsSettings {
  uiFamily: string;
  uiSize: number;
  codeFamily: string;
  codeSize: number;
}

/** 图标主题出现范围键（图标主题 spec §3.1）：settingsDraft 的白名单镜像
 * （validateSettings 节块 + collectUnknownPaths 键级）同源消费。 */
export const ICON_THEME_SCOPE_KEYS = ['tree', 'tabs', 'quickOpen', 'search'] as const;

/** 图标主题设置（图标主题 spec §3.1，Task 3）：theme 单选且不随亮暗切换
 * （'none' 关闭 = 现状无图标 / 'seti' 内置预置 / 'imported:<id>' 导入记录 id）；
 * scopes 为出现范围四开关（默认仅文件树开启）。 */
export interface IconThemesSettings {
  theme: 'none' | 'seti' | `imported:${string}`;
  scopes: Record<(typeof ICON_THEME_SCOPE_KEYS)[number], boolean>;
}

/** 存储与数据节（远端下载确认门 spec §6.4，计划 2 Task 5）：remoteDownloadConfirmMb
 * 为远端全量物化（R1/R2）下载前的确认阈值，MB 计，clamp 范围见 STORAGE_MB_RANGE；
 * size 未知的不定态下载不适用确认门（无前置数字）。 */
export interface StorageSettings {
  remoteDownloadConfirmMb: number;
}

export interface Settings {
  themeMode: 'light' | 'dark' | 'system';
  /** 亮/暗模式下各自记忆的外观主题（'default' | 'vscode:…' 内置名 | 'imported:<id>'）；
   * 非 default 时代码槽由外观的 tokenColors 表接管（theme.ts applyAppearance） */
  appearanceLight: string;
  appearanceDark: string;
  /** 亮/暗模式下各自记忆的代码主题（键名需存在于 @bhxch/vviewer-highlight 的 themes.json） */
  codeThemeLight: string;
  codeThemeDark: string;
  excludedPatterns: string[];
  autoRefresh: boolean;
  /** 计算策略（M6）：auto=远程文件优先远程计算（失败回退本地）；local/remote=显式指定 */
  computePolicy: ComputePolicy;
  diagrams: DiagramsSettings;
  fonts: FontsSettings;
  /** 图标主题节（图标主题 spec §3.1，Task 3）：单选主题 + 出现范围四开关，
   * AppShell 单订阅联动（reactToIconsChange）+ FileIcon 消费。 */
  iconThemes: IconThemesSettings;
  /** 布局节（spec 2026-10-19 布局自由化 §2）：折叠/宽度/chrome 可见性/zen。
   * 类型与白名单在 lib/layout.ts（纯函数可单测）；AppShell 消费。 */
  layout: LayoutSettings;
  /** 存储与数据节（远端下载确认门 spec §6.4，计划 2 Task 5）：远端下载确认阈值。
   * UI 在 SettingsCenter「存储与数据」节；ViewerPane 泵启动前消费。 */
  storage: StorageSettings;
  /** 默认渲染器偏好（同一扩展名有多个可用渲染器时）：小写扩展名 → 渲染器 id，
   * '' 或缺省 = 内置默认（注册表扩展名所有者）。改回默认写 ''（mergeDraftOnto 删键
   * 不传播）。UI 在 SettingsCenter「打开方式」节；viewer.ts 注入
   * registry.setPreferenceResolver 消费——id 不是该扩展名候选时自动回落内置默认。 */
  rendererDefaults: Record<string, string>;
}

const KEY = 'vviewer:settings';
/**
 * 全字段默认值（键集 = Settings 键集，TS 静态锁全键——缺键编译错、多键不可能）。
 * FE-3 起导出：settingsDraft 的白名单 SETTINGS_KEYS 以 Object.keys(DEFAULTS)
 * 派生（键集运行时唯一真相，「新增字段忘登记白名单→导入静默丢字段」不可再发生）；
 * 键序与原手工清单逐键一致（localStorage 落盘字节面零漂移）。
 */
export const DEFAULTS: Settings = {
  themeMode: 'system',
  appearanceLight: 'default',
  appearanceDark: 'default',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  excludedPatterns: [],
  autoRefresh: true,
  computePolicy: 'auto',
  diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} },
  fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 },
  iconThemes: { theme: 'none', scopes: { tree: true, tabs: false, quickOpen: false, search: false } },
  layout: DEFAULT_LAYOUT,
  storage: { remoteDownloadConfirmMb: 512 },
  rendererDefaults: {}
};

const POLICIES: readonly ComputePolicy[] = ['auto', 'local', 'remote'];
/** rendererDefaults 键/值形态（normalizeSettings 与 settingsDraft 校验同源）：键为小写
 * 无点扩展名；值为渲染器 id（注册表 id 均为小写连字符形态），'' = 内置默认。 */
export const RENDERER_DEFAULT_EXT_RE = /^[a-z0-9][a-z0-9_+-]*$/;
export const RENDERER_DEFAULT_ID_RE = /^(?:[a-z0-9][a-z0-9-]*)?$/;
/** 字号 clamp 范围（spec §2.1：uiSize 10–28 / codeSize 9–28） */
export const UI_SIZE_RANGE = [10, 28] as const;
export const CODE_SIZE_RANGE = [9, 28] as const;
/** 远端下载确认阈值 clamp 范围（spec §6.4：MB 计，1–4096；默认 512） */
export const STORAGE_MB_RANGE = [1, 4096] as const;

function defaults(): Settings {
  return {
    ...DEFAULTS,
    excludedPatterns: [...DEFAULTS.excludedPatterns],
    diagrams: {
      krokiHost: DEFAULTS.diagrams.krokiHost,
      krokiVia: DEFAULTS.diagrams.krokiVia,
      mermaidTheme: DEFAULTS.diagrams.mermaidTheme,
      modes: { ...DEFAULTS.diagrams.modes },
      renderers: { ...DEFAULTS.diagrams.renderers }
    },
    fonts: { ...DEFAULTS.fonts },
    iconThemes: { theme: DEFAULTS.iconThemes.theme, scopes: { ...DEFAULTS.iconThemes.scopes } },
    layout: { ...DEFAULTS.layout },
    storage: { ...DEFAULTS.storage },
    rendererDefaults: { ...DEFAULTS.rendererDefaults }
  };
}

/** 字号 clamp（脏值 typeof 守卫后四舍五入夹紧；非有限数字归位默认）。导出供面板
 * 字号输入同口径消费（终审 M-2：13.7 → 14，输入侧与白名单侧不再一处取整一处截断） */
export function clampSize(v: unknown, range: readonly [number, number] | readonly number[], dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(range[1]!, Math.max(range[0]!, Math.round(v)));
}

/**
 * 白名单规范化（loadSettings 的唯一实现体，Task 2 起导出共享）：未知键原样
 * 透传不剔除（历史行为——settings.test.ts 锁定），已知字段逐个校验/归位/clamp。
 * 消费方：loadSettings（localStorage 读回）与 settingsDraft.ts 的
 * replaceImported/applyJson（导入与 JSON 视图的同一规范化语义）。
 */
export function normalizeSettings(partial: Record<string, unknown>): Settings {
  const s = { ...defaults(), ...(partial as Partial<Settings>) };
  // computePolicy 白名单校验：旧版本/手改 localStorage 的非法值回落默认
  if (!POLICIES.includes(s.computePolicy)) s.computePolicy = DEFAULTS.computePolicy;
  // 外观槽格式白名单（spec 2026-10-12 §2.3）：'default' 或 'vscode:'/'imported:'
  // 前缀；存在性校验（内置名单/imported id）由注入期 warn+回退兜底，此处只挡格式
  for (const key of ['appearanceLight', 'appearanceDark'] as const) {
    const v = s[key];
    // typeof 守卫前置：非字符串脏值（如 JSON 里的数字）走字段级归位，
    // 否则 startsWith 抛 TypeError 被外层 try/catch 兜成整体回落 defaults()
    if (typeof v !== 'string' || (v !== 'default' && !v.startsWith('vscode:') && !v.startsWith('imported:'))) {
      s[key] = DEFAULTS[key];
    }
  }
  // diagrams 节白名单（spec §2.1）：host 必须 http(s):// 或空；krokiVia 二枚举
  //（spec §8.3，脏值归位 client=直发现状）；mermaidTheme 六值白名单（spec §9.2，
  // 脏值归位 'auto'=跟随亮暗现状）；modes 键须在注册表、值须五枚举（'official'
  // 官方服务器档，2026-10-30——注册表能力门控面由设置 UI 按 officialServer 旗标出
  // option，白名单只挡枚举外值，与 'server' 同款先例）；
  // renderers（spec §9.1）键须在注册表、值须命中该类型注册表 renderers 选择面
  //（per-type 数据驱动而非扁平枚举——hpcc 仅 graphviz 合法），非法键值剔除=默认 viz-js
  const d = s.diagrams ?? DEFAULTS.diagrams;
  s.diagrams = {
    krokiHost: typeof d.krokiHost === 'string' && /^https?:\/\//.test(d.krokiHost) ? d.krokiHost : '',
    krokiVia: d.krokiVia === 'server' ? 'server' : 'client',
    mermaidTheme: MERMAID_THEME_VALUES.includes(d.mermaidTheme as MermaidTheme | 'auto')
      ? (d.mermaidTheme as MermaidTheme | 'auto')
      : 'auto',
    modes: Object.fromEntries(
      Object.entries(typeof d.modes === 'object' && d.modes !== null ? d.modes : {}).flatMap(([k, v]): [string, DiagramMode][] => {
        const t = resolveDiagramType(k);
        return t && (v === 'local' || v === 'kroki' || v === 'server' || v === 'official' || v === 'source') ? [[k, v]] : [];
      })
    ),
    renderers: Object.fromEntries(
      Object.entries(typeof d.renderers === 'object' && d.renderers !== null ? d.renderers : {}).flatMap(([k, v]): [string, string][] => {
        const t = resolveDiagramType(k);
        return typeof v === 'string' && t?.renderers?.includes(v) ? [[k, v]] : [];
      })
    )
  };
  // fonts 节白名单（字体系统 spec §2.1）：family 非字符串归空栈；字号 clamp
  //（uiSize 10–28 / codeSize 9–28），脏 JSON 字段级归位不抛
  const f = s.fonts ?? DEFAULTS.fonts;
  s.fonts = {
    uiFamily: typeof f.uiFamily === 'string' ? f.uiFamily : DEFAULTS.fonts.uiFamily,
    uiSize: clampSize(f.uiSize, UI_SIZE_RANGE, DEFAULTS.fonts.uiSize),
    codeFamily: typeof f.codeFamily === 'string' ? f.codeFamily : DEFAULTS.fonts.codeFamily,
    codeSize: clampSize(f.codeSize, CODE_SIZE_RANGE, DEFAULTS.fonts.codeSize)
  };
  // iconThemes 节白名单（图标主题 spec §3.1，Task 3）：theme 三态白名单（'none'/
  // 'seti'/'imported:' 前缀，脏值归 'none' = 无图标现状语义，仿 appearance 槽的
  // 格式白名单口径）；scopes 四键逐键布尔化归位（未知键剔除不落盘、非布尔归位
  // 默认——同 fonts 节「脏 JSON 字段级归位不抛」口径）
  const it = typeof s.iconThemes === 'object' && s.iconThemes !== null ? s.iconThemes : DEFAULTS.iconThemes;
  // scopes 二级防御（节脏值 42 后 it.scopes 为 undefined 不可再取键）：非对象回落
  // 默认同型值（false 分支不落 {}，免联合类型属性访问报错）
  const its = typeof it.scopes === 'object' && it.scopes !== null ? it.scopes : DEFAULTS.iconThemes.scopes;
  s.iconThemes = {
    theme:
      it.theme === 'none' || it.theme === 'seti' || (typeof it.theme === 'string' && it.theme.startsWith('imported:'))
        ? (it.theme as IconThemesSettings['theme'])
        : DEFAULTS.iconThemes.theme,
    scopes: {
      tree: typeof its.tree === 'boolean' ? its.tree : DEFAULTS.iconThemes.scopes.tree,
      tabs: typeof its.tabs === 'boolean' ? its.tabs : DEFAULTS.iconThemes.scopes.tabs,
      quickOpen: typeof its.quickOpen === 'boolean' ? its.quickOpen : DEFAULTS.iconThemes.scopes.quickOpen,
      search: typeof its.search === 'boolean' ? its.search : DEFAULTS.iconThemes.scopes.search
    }
  };
  // layout 节白名单（布局自由化 spec §2）：字段级归位 + 宽度 clamp，
  // 校验数学在 lib/layout.ts sanitizeLayout（可单测），此处只接线
  s.layout = sanitizeLayout(s.layout);
  // storage 节白名单（远端下载确认门 spec §6.4，计划 2 Task 5）：阈值 MB 计
  // clamp 1–4096（脏 JSON 字段级归位默认 512，同 fonts 字号口径）；节脏值回落
  // 默认形态，不拖垮其余字段
  const st = typeof s.storage === 'object' && s.storage !== null ? s.storage : DEFAULTS.storage;
  s.storage = {
    remoteDownloadConfirmMb: clampSize(st.remoteDownloadConfirmMb, STORAGE_MB_RANGE, DEFAULTS.storage.remoteDownloadConfirmMb)
  };
  // rendererDefaults 白名单：只挡形态（键小写扩展名、值渲染器 id 或 ''），不查注册表——
  // 该 id 能否渲染该扩展名由 registry.byExtension 消费时裁决（非候选回落所有者），
  // settings 不依赖渲染器装配；节脏值回落空表，不拖垮其余字段
  const rd = s.rendererDefaults;
  s.rendererDefaults = Object.fromEntries(
    Object.entries(typeof rd === 'object' && rd !== null && !Array.isArray(rd) ? rd : {}).flatMap(([k, v]): [string, string][] =>
      RENDERER_DEFAULT_EXT_RE.test(k) && typeof v === 'string' && RENDERER_DEFAULT_ID_RE.test(v) ? [[k, v]] : []
    )
  );
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return normalizeSettings(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return defaults();
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
  notify(s);
}

// ---------- 变更订阅（BUG-05 前置基建） ----------
// 普通 .ts 不能用 runes（计划已核实文件后缀），以回调集合实现发布订阅：
// saveSettings 落盘后同步通知；AppShell 等订阅方据此刷新响应式副本。

type SettingsListener = (s: Settings) => void;

const listeners = new Set<SettingsListener>();

/**
 * 订阅设置变更（saveSettings 触发）；返回退订函数。
 * 回调收到的是深一层的副本（excludedPatterns 数组、diagrams.modes 均拷贝），
 * 订阅方改动不回灌。
 */
export function onSettingsChanged(cb: SettingsListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(s: Settings): void {
  for (const cb of listeners) {
    cb({
      ...s,
      excludedPatterns: [...s.excludedPatterns],
      diagrams: { ...s.diagrams, modes: { ...s.diagrams.modes }, renderers: { ...s.diagrams.renderers } },
      fonts: { ...s.fonts },
      iconThemes: { theme: s.iconThemes.theme, scopes: { ...s.iconThemes.scopes } },
      layout: { ...s.layout },
      storage: { ...s.storage },
      rendererDefaults: { ...s.rendererDefaults }
    });
  }
}
