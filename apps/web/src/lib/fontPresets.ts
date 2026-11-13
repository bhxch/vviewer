// fontPresets.ts — 预设网络字体清单（spec C §3.3，Task 4；builder 实测选定终版）。
// 纯 .ts 数据清单（vitest 直测）：每条目多源（label 可见——jsdelivr/unpkg/npmmirror），
// 一键添加 UI 层按 sources[label] 取 URL 调 fontsStore 对应通道（single=addFontFromUrl
// 复用既有重名/30MB/https/装载验证门禁；css=addCssFont 落库+link 插拔），不新造门禁。
//
// URL 实测台账（2026-11-14 builder 逐条 curl：200 + content-type + ACAO=*）：
// - css 型三源全通：jsdelivr/unpkg（text/css；切片相对引用同包内自动解析）+
//   npmmirror files 通道（第三方包开放——本仓 @bhxch/* 白名单 403 不适用第三方）；
//   切片实抽（lxgw files/lxgwwenkai-regular-subset-4.woff2）三源 200 font/woff2。
// - single 型双源全通（@fontsource files woff2，font/woff2）——计划「每条 ≥2 源：
//   jsdelivr + unpkg」满足；西文条目不设中文源（可达性语义无增益）。
// - 版本钉死纪律（foreignAssets.ts:15-16 先例）：精确版本直链，升级=显式单独
//   commit（实测时点版本号见下，@fontsource 系 5.3.x / lxgw 1.7.0）。
//
// family 语义：css 型 = css 内 font-family（'LXGW WenKai' 实抽 index.css/style.css
// 确认；已添加态判定与槽位引用均按记录 name=family 比对）；single 型 = 添加时的
// 记录 name（显式传入 preset.family）。displayName 为显示数据值（含 CJK 以 \u
// 转义形态保留——D8 非翻译数据值纪律，lint 按源码 raw 形态匹配）。

export interface WebFontPresetSource {
  /** 来源标签（UI 可见——jsdelivr / unpkg / npmmirror） */
  label: string;
  /** 添加 URL（css 型=切片 css 入口；single 型=woff2 直链） */
  url: string;
}

export interface WebFontPreset {
  /** 字体族名（槽位/下拉键；css 型=css 内 font-family，single 型=记录 name） */
  family: string;
  /** 预设列表显示名（数据值；含 CJK 以 \u 转义，D8） */
  displayName: string;
  /** 'single'=FontFace 单文件入库离线；'css'=切片在线（link 插拔，断网回退缺省） */
  kind: 'single' | 'css';
  /** 多源清单（每源一个添加钮；首源=缺省推荐源） */
  sources: readonly WebFontPresetSource[];
}

const SRC = {
  jsdelivr: (path: string): string => `https://cdn.jsdelivr.net/npm/${path}`,
  unpkg: (path: string): string => `https://unpkg.com/${path}`,
  npmmirror: (pkg: string, ver: string, file: string): string =>
    `https://registry.npmmirror.com/${pkg}/${ver}/files/${file}`
} as const;

/** 西文 single 型：@fontsource files 的 latin 400 woff2 直链（双源）。 */
function fontsourceSingle(pkg: string, ver: string, family: string): WebFontPreset {
  const file = `${pkg}/${ver}/files/${pkg.replace('@fontsource/', '')}-latin-400-normal.woff2`;
  return {
    family,
    displayName: family,
    kind: 'single',
    sources: [
      { label: 'jsdelivr', url: SRC.jsdelivr(file) },
      { label: 'unpkg', url: SRC.unpkg(file) }
    ]
  };
}

/** 中文 css 型：@fontsource index.css（三源，含 npmmirror 中文源）。 */
function fontsourceCss(pkg: string, ver: string, family: string): WebFontPreset {
  return {
    family,
    displayName: family,
    kind: 'css',
    sources: [
      { label: 'jsdelivr', url: SRC.jsdelivr(`${pkg}@${ver}/index.css`) },
      { label: 'unpkg', url: SRC.unpkg(`${pkg}@${ver}/index.css`) },
      { label: 'npmmirror', url: SRC.npmmirror(pkg, ver, 'index.css') }
    ]
  };
}

export const FONT_PRESETS: readonly WebFontPreset[] = [
  {
    family: 'LXGW WenKai',
    // 霞鹜文楷 LXGW WenKai（D8：CJK 以 \u 转义——\u971e\u9e5c\u6587\u6977 = 霞鹜文楷）
    displayName: '\u971e\u9e5c\u6587\u6977 LXGW WenKai',
    kind: 'css',
    sources: [
      { label: 'jsdelivr', url: SRC.jsdelivr('lxgw-wenkai-webfont@1.7.0/style.css') },
      { label: 'unpkg', url: SRC.unpkg('lxgw-wenkai-webfont@1.7.0/style.css') },
      { label: 'npmmirror', url: SRC.npmmirror('lxgw-wenkai-webfont', '1.7.0', 'style.css') }
    ]
  },
  fontsourceCss('@fontsource/noto-sans-sc', '5.3.1', 'Noto Sans SC'),
  fontsourceCss('@fontsource/noto-serif-sc', '5.3.1', 'Noto Serif SC'),
  fontsourceSingle('@fontsource/jetbrains-mono', '5.3.0', 'JetBrains Mono'),
  fontsourceSingle('@fontsource/fira-code', '5.3.0', 'Fira Code'),
  fontsourceSingle('@fontsource/iosevka', '5.3.0', 'Iosevka'),
  fontsourceSingle('@fontsource/inter', '5.3.0', 'Inter')
] as const;
