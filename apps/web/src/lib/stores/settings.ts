import type { ComputePolicy } from '@vviewer/core';
import { resolveDiagramType, type DiagramMode } from '@vviewer/render-text/markdown/diagrams';

/** 图表渲染设置（spec 2026-10-19 §2.1）：krokiHost 空串 = 用注册表 DEFAULT_KROKI_HOST；
 * modes 键 = 图表类型 id/别名，值覆盖注册表 defaultMode（Task 7 面板消费）。 */
export interface DiagramsSettings {
  krokiHost: string;
  modes: Record<string, DiagramMode>;
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
  /** 亮/暗模式下各自记忆的代码主题（键名需存在于 @vviewer/highlight 的 themes.json） */
  codeThemeLight: string;
  codeThemeDark: string;
  excludedPatterns: string[];
  autoRefresh: boolean;
  /** 计算策略（M6）：auto=远程文件优先远程计算（失败回退本地）；local/remote=显式指定 */
  computePolicy: ComputePolicy;
  diagrams: DiagramsSettings;
  fonts: FontsSettings;
}

const KEY = 'vviewer:settings';
const DEFAULTS: Settings = {
  themeMode: 'system',
  appearanceLight: 'default',
  appearanceDark: 'default',
  codeThemeLight: 'onelight',
  codeThemeDark: 'serika-dark',
  excludedPatterns: [],
  autoRefresh: true,
  computePolicy: 'auto',
  diagrams: { krokiHost: '', modes: {} },
  fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 }
};

const POLICIES: readonly ComputePolicy[] = ['auto', 'local', 'remote'];
/** 字号 clamp 范围（spec §2.1：uiSize 10–28 / codeSize 9–28） */
export const UI_SIZE_RANGE = [10, 28] as const;
export const CODE_SIZE_RANGE = [9, 28] as const;

function defaults(): Settings {
  return {
    ...DEFAULTS,
    excludedPatterns: [...DEFAULTS.excludedPatterns],
    diagrams: { krokiHost: DEFAULTS.diagrams.krokiHost, modes: { ...DEFAULTS.diagrams.modes } },
    fonts: { ...DEFAULTS.fonts }
  };
}

/** 字号 clamp（脏值 typeof 守卫后夹紧；非有限数字归位默认） */
function clampSize(v: unknown, range: readonly [number, number] | readonly number[], dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(range[1]!, Math.max(range[0]!, v));
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const s = { ...defaults(), ...(JSON.parse(raw) as Partial<Settings>) };
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
    // diagrams 节白名单（spec §2.1）：host 必须 http(s):// 或空；modes 键须在注册表、值须三枚举
    const d = s.diagrams ?? DEFAULTS.diagrams;
    s.diagrams = {
      krokiHost: typeof d.krokiHost === 'string' && /^https?:\/\//.test(d.krokiHost) ? d.krokiHost : '',
      modes: Object.fromEntries(
        Object.entries(typeof d.modes === 'object' && d.modes !== null ? d.modes : {}).flatMap(([k, v]): [string, DiagramMode][] => {
          const t = resolveDiagramType(k);
          return t && (v === 'local' || v === 'kroki' || v === 'source') ? [[k, v]] : [];
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
    return s;
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
      diagrams: { ...s.diagrams, modes: { ...s.diagrams.modes } },
      fonts: { ...s.fonts }
    });
  }
}
