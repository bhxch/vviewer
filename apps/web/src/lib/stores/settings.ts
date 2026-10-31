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
  /** 布局节（spec 2026-10-19 布局自由化 §2）：折叠/宽度/chrome 可见性/zen。
   * 类型与白名单在 lib/layout.ts（纯函数可单测）；AppShell 消费。 */
  layout: LayoutSettings;
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
  layout: DEFAULT_LAYOUT
};

const POLICIES: readonly ComputePolicy[] = ['auto', 'local', 'remote'];
/** 字号 clamp 范围（spec §2.1：uiSize 10–28 / codeSize 9–28） */
export const UI_SIZE_RANGE = [10, 28] as const;
export const CODE_SIZE_RANGE = [9, 28] as const;

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
    layout: { ...DEFAULTS.layout }
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
  // layout 节白名单（布局自由化 spec §2）：字段级归位 + 宽度 clamp，
  // 校验数学在 lib/layout.ts sanitizeLayout（可单测），此处只接线
  s.layout = sanitizeLayout(s.layout);
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
      layout: { ...s.layout }
    });
  }
}
