import languagesTable from '../assets/languages.json';

/**
 * 语言检测：扩展名精确表（helix languages.json 的 fileTypes）+ shebang 首行检测。
 * 返回值对齐 grammar wasm 清单键（languages.json 的 grammar 字段，缺省用语言键名）。
 */

interface LangEntry {
  fileTypes?: string[];
  shebangs?: string[];
  grammar?: string;
}

/** `#!/usr/bin/env python3` → `python`（路径与 env/-flags 剥离，捕获段排除点与数字以剥版本号） */
const SHEBANG_RE = /^#!\s*(?:\S*[/\\](?:env\s+(?:-\S+\s+)*)?)?([^\s.\d]+)/;

let extToLang: Map<string, string> | null = null;
let shebangToLang: Map<string, string> | null = null;

/** 构建查询表（模块级懒加载：首次 detectLanguage 调用时构建一次） */
function buildTables(): void {
  if (extToLang && shebangToLang) return;
  extToLang = new Map();
  shebangToLang = new Map();
  for (const [name, entry] of Object.entries(languagesTable as Record<string, LangEntry>)) {
    const lang = entry.grammar ?? name;
    for (const ft of entry.fileTypes ?? []) {
      const ext = ft.toLowerCase();
      if (!extToLang.has(ext)) extToLang.set(ext, lang);
    }
    for (const sb of entry.shebangs ?? []) {
      if (!shebangToLang.has(sb)) shebangToLang.set(sb, lang);
    }
  }
}

/**
 * 检测语言：ext 优先查 fileTypes 精确表；未命中且给了 text 时用首行 shebang
 * 映射 languages.json 的 shebangs 字段。都未命中返回 null。
 */
export function detectLanguage(ext: string, text?: string): string | null {
  buildTables();
  const hit = extToLang!.get(ext.toLowerCase());
  if (hit) return hit;
  if (text !== undefined && text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    const firstLine = newline < 0 ? text : text.slice(0, newline);
    const m = SHEBANG_RE.exec(firstLine);
    if (m) return shebangToLang!.get(m[1]!) ?? null;
  }
  return null;
}
