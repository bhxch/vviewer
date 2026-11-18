// cdnProfiles.ts — settings.cdn 三作用面档位解析（spec C §3.2，Task 3）：grammars 四档
// default|unpkg|cn|custom、engines/foreign 两档 default|custom。纯 .ts、零 $app/零 store
// import（foreignAssets.ts 同款纯度纪律——vite define 注入面与 vitest 直测共享消费面）。
//
// 多基格式（Global Constraints）：`|` 分隔逐子包 base，解析器兼容无分隔符单值（单基=单
// 元素数组，build:e2e/ci.yml 既有单基注入零回归）。
//
// unpkg/cn 档 URL 形态（builder check 落定「起步直用缺省重定向形态」）：unpkg 不带版本
// （latest 重定向，实测 -L 200 + ACAO）；cn = npmmirror files 通道 latest tag（白名单
// 申请中，落地前不可用——CdnSection 警示行承接）。版本解析固化（resolveCdnPackVersions）
// 为信息面：设置 UI 显示解析值 + 手动重解析（结果缓存独立 localStorage 键，不扩
// settings.cdn 钉死 6 字段集），解析失败回退重定向形态提示。
import { resolveForeignAssetBase } from './foreignAssets';

/**
 * grammar 拆包子包的 npm scope（构建期注入 VV_NPM_SCOPE，缺省 @bhxch）。
 *
 * 与发布链同源：release.yml / pages-deploy.yml 注入 `vars.NPM_SCOPE`（仓库变量未配置
 * 时回落缺省 @bhxch）——此前本文件把 scope 写死 @bhxch，与发布变量互不连通：发布换
 * scope 后 unpkg/cn 两档 URL 全 404，且缺层仅 console.warn（用户只见「没高亮」）。
 */
export const GRAMMAR_PACK_SCOPE =
  (import.meta as { env?: { VV_NPM_SCOPE?: string } }).env?.VV_NPM_SCOPE ?? '@bhxch';

/** 拆分子包包名（scope + 全量包名）——与发布链 VV_NPM_PACKAGE_NAME 同形。 */
export const GRAMMAR_PACK_NAME = `${GRAMMAR_PACK_SCOPE}/vviewer-grammars-full`;

/** unpkg/npmmirror 子包版本解析结果的独立缓存键（不扩 settings.cdn 6 字段集——裁量记档）。 */
export const CDN_VERSIONS_CACHE_KEY = 'vviewer:cdn-versions';

/**
 * 子包数解析（vite define 注入 VV_GRAMMAR_PACK_COUNT，构建期定型；缺省 '1' = 单基
 * 兼容锚）。envValue 测试注入面；非法/非正数/负数防御归 1。
 */
export function grammarPackCount(envValue?: string): number {
  const raw =
    envValue ??
    (import.meta as { env?: { VV_GRAMMAR_PACK_COUNT?: string } }).env?.VV_GRAMMAR_PACK_COUNT ??
    '1';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/**
 * 多基解析：`|` 分隔 + trim + 空段剔除 + 逐基尾斜杠归一（补 /）。
 * 无分隔符单值 = 单元素数组（单基兼容锚）；空串 = 空数组（CDN 层缺席语义）。
 */
export function parseMultiBase(value: string): string[] {
  return value
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => (s.endsWith('/') ? s : `${s}/`));
}

/**
 * grammars custom 多基契约校验：非空且逐基以 /grammars/ 结尾（manifest 与 wasm 同目录
 * 布局契约，highlightDefault.normalizeGrammarsBase 同款）。settingsDraft 白名单镜像与
 * CdnSection 输入错误态同口径消费。
 */
export function grammarsMultiBaseOk(value: string): boolean {
  const bases = parseMultiBase(value);
  return bases.length > 0 && bases.every((b) => b.endsWith('/grammars/'));
}

/**
 * engines/foreign custom host 校验：以 / 结尾的 https URL（空串非法=未启用语义）。
 */
export function enginesHostOk(value: string): boolean {
  return /^https:\/\/.+\/$/.test(value);
}

/** foreign custom host 校验（同 enginesHostOk 口径，独立命名保语义自明）。 */
export function foreignBaseOk(value: string): boolean {
  return enginesHostOk(value);
}

/** 拆分子包 URL 构造（p1..pN 连续自 1，包名对齐发布面 GRAMMAR_PACK_NAME）。 */
function packGrammarsBases(prefix: (i: number) => string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix(i + 1)}/grammars/`);
}

/** unpkg 档：不带版本缺省重定向形态（latest 重定向，builder check 实测 200+ACAO）。
 * count 参数化导出（N>1 形态直测面；resolveGrammarCdnBases 以 grammarPackCount() 注入）。 */
export function unpkgGrammarsBases(count: number): string[] {
  return packGrammarsBases((i) => `https://unpkg.com/${GRAMMAR_PACK_NAME}-p${i}`, count);
}

/** cn 档：npmmirror files 通道 latest tag 形态（白名单申请中，落地前不可用）。 */
export function npmmirrorGrammarsBases(count: number): string[] {
  return packGrammarsBases((i) => `https://registry.npmmirror.com/${GRAMMAR_PACK_NAME}-p${i}/latest/files`, count);
}

/**
 * grammars CDN base 解析（四档）。返回 null = custom 值非空但校验失败（UI 错误态，
 * 不静默吞）；返回 [] = default 档 env 未注入（CDN 层缺席，现状语义）；
 * 空串 custom = 未启用回 default 档行为。
 */
export function resolveGrammarCdnBases(settings: Settings, envDefault: string): string[] | null {
  const { grammars, grammarsCustom } = settings.cdn;
  switch (grammars) {
    case 'unpkg':
      return unpkgGrammarsBases(grammarPackCount());
    case 'cn':
      return npmmirrorGrammarsBases(grammarPackCount());
    case 'custom':
      if (grammarsCustom === '') return parseMultiBase(envDefault); // 空串=未启用走缺省注入
      return grammarsMultiBaseOk(grammarsCustom) ? parseMultiBase(grammarsCustom) : null;
    case 'default':
    default:
      return parseMultiBase(envDefault);
  }
}

/**
 * engines CDN host 解析（两档）：undefined = 缺省（jsdelivr 常量，cdnEngines.ts 链尾）；
 * custom 合法值透传（diagramOptions.cdnEnginesHost）。非法值 undefined（UI 错误态承接）。
 */
export function resolveEnginesHost(settings: Settings): string | undefined {
  if (settings.cdn.engines !== 'custom') return undefined;
  return enginesHostOk(settings.cdn.enginesCustom) ? settings.cdn.enginesCustom : undefined;
}

/**
 * foreign 资产基座解析（两档）：default=缺省三层链（resolveForeignAssetBase：
 * env → 同源 → 缺省 CDN）；custom 合法值覆写（插在缺省 CDN 前，env 显式层仍最优先——
 * 链序实现在 resolveForeignAssetBase 内部）。空串/非法值走缺省链（UI 错误态承接）。
 * foreign 生效语义=切档保存后刷新页面生效（装配级快照，foreignRenderers 装配时读当下
 * settings）。
 */
export function resolveForeignBase(settings: Settings, env?: string): string {
  const custom = settings.cdn.foreign === 'custom' ? settings.cdn.foreignCustom : '';
  return resolveForeignAssetBase(env, foreignBaseOk(custom) ? custom : '');
}

/** settings 类型（仅类型导入——零 store 运行时依赖保持纯度） */
type Settings = import('./stores/settings').Settings;

// ---------- unpkg/npmmirror 子包版本解析（UI 信息面：显示解析值 + 手动重解析） ----------

interface CdnVersionsCache {
  [profile: string]: { count: number; versions: string[] } | undefined;
}

/**
 * 逐子包版本解析（unpkg meta=package.json / npmmirror registry latest），结果缓存独立
 * localStorage 键（按 profile 分段，count 变化视为失配重新解析）。任一子包解析失败或
 * 无缓存即返回 null——UI 回退「重定向形态运行中」提示（运行时 URL 恒重定向形态，
 * 解析值仅供核对 latest 版本，不改变运行时 URL）。
 */
export async function resolveCdnPackVersions(profile: 'unpkg' | 'cn', count: number): Promise<string[] | null> {
  const cached = readCache(profile);
  if (cached && cached.count === count) return cached.versions;
  const versions: string[] = [];
  for (let i = 1; i <= count; i++) {
    const v = await resolvePackVersion(profile, i);
    if (v === null) return null;
    versions.push(v);
  }
  writeCache(profile, { count, versions });
  return versions;
}

function readCache(profile: string): { count: number; versions: string[] } | null {
  try {
    const raw = localStorage.getItem(CDN_VERSIONS_CACHE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as CdnVersionsCache)[profile] ?? null;
  } catch {
    return null;
  }
}

function writeCache(profile: string, value: { count: number; versions: string[] }): void {
  try {
    const raw = localStorage.getItem(CDN_VERSIONS_CACHE_KEY);
    const cache: CdnVersionsCache = raw ? (JSON.parse(raw) as CdnVersionsCache) : {};
    cache[profile] = value;
    localStorage.setItem(CDN_VERSIONS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 缓存写失败（配额/隐私模式）静默——信息面不阻断
  }
}

async function resolvePackVersion(profile: 'unpkg' | 'cn', i: number): Promise<string | null> {
  const url =
    profile === 'unpkg'
      ? `https://unpkg.com/${GRAMMAR_PACK_NAME}-p${i}/package.json`
      : `https://registry.npmmirror.com/${GRAMMAR_PACK_NAME}-p${i}/latest`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === 'string' && json.version !== '' ? json.version : null;
  } catch {
    return null;
  }
}
