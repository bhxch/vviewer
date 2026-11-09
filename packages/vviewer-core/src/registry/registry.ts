import type { Renderer, RendererId } from '../types';

export class RegistryError extends Error {
  constructor(ext: string, existing: RendererId, incoming: RendererId) {
    super(`扩展名 ".${ext}" 已被 renderer "${existing}" 注册，拒绝 "${incoming}" 重复注册`);
  }
}

/** 默认渲染器偏好：小写扩展名 → 渲染器 id；undefined/'' = 用扩展名所有者 */
export type RendererPreferenceResolver = (ext: string) => RendererId | undefined;

export interface Registry {
  install(r: Renderer): void;
  installFallbackExtensions(ownerId: RendererId, exts: readonly string[]): { added: string[]; skipped: string[] };
  /** 扩展名的生效渲染器：偏好解析器给出的 id 属于该扩展名候选（candidatesOf）时用它，
   * 否则为扩展名所有者。dispatcher 选路、确认门文案、嵌套附件分派同经此入口，
   * 偏好对所有消费面一致生效。 */
  byExtension(ext: string): Renderer | undefined;
  /** 扩展名所有者（内置默认，不读偏好） */
  ownerOf(ext: string): Renderer | undefined;
  /** 能渲染该扩展名的全部渲染器：所有者在前，altExtensions 声明者按安装序在后（去重） */
  candidatesOf(ext: string): Renderer[];
  /** 注入默认渲染器偏好（应用侧闭包现读设置）；null 撤销 */
  setPreferenceResolver(resolve: RendererPreferenceResolver | null): void;
  byId(id: string): Renderer | undefined;
  all(): Renderer[];
}

export function createRegistry(): Registry {
  const byExt = new Map<string, Renderer>();
  const byId = new Map<string, Renderer>();
  // 候选扩展名 → 声明者（安装序）。不进 byExt：候选不抢所有权，也不参与冲突检测
  const altByExt = new Map<string, Renderer[]>();
  let preference: RendererPreferenceResolver | null = null;

  const candidatesOf = (ext: string): Renderer[] => {
    const key = ext.toLowerCase();
    const owner = byExt.get(key);
    const out = owner ? [owner] : [];
    for (const r of altByExt.get(key) ?? []) if (!out.includes(r)) out.push(r);
    return out;
  };

  return {
    install(r) {
      if (byId.has(r.id)) throw new Error(`Renderer id "${r.id}" 已存在`);
      // 扩展名归一为小写再登记/查冲突：byExtension 查询侧已小写化，注册侧同步归一，
      // 否则 ".TS" 与 ".ts" 会各占一键、冲突检测漏报
      const exts = r.extensions.map((e) => e.toLowerCase());
      for (const ext of exts) {
        const owner = byExt.get(ext);
        if (owner && owner.id !== r.id) throw new RegistryError(ext, owner.id, r.id);
      }
      byId.set(r.id, r);
      for (const ext of exts) byExt.set(ext, r);
      for (const ext of new Set((r.altExtensions ?? []).map((e) => e.toLowerCase()))) {
        const list = altByExt.get(ext);
        if (list) list.push(r);
        else altByExt.set(ext, [r]);
      }
    },
    installFallbackExtensions(ownerId, exts) {
      const owner = byId.get(ownerId);
      if (!owner) throw new Error(`Renderer id "${ownerId}" 不存在，无法补注册扩展名`);
      const added: string[] = [];
      const skipped: string[] = [];
      // 生成物只补空位：专有渲染器先注册（C 项装配铁律），被占即跳过——
      // jsonl/ndjson 等未来由专有渲染器（D 项）注册后天然免疫生成物覆盖
      for (const raw of [...exts].sort()) {
        const ext = raw.toLowerCase();
        const existing = byExt.get(ext);
        if (existing) {
          skipped.push(ext);
          continue;
        }
        byExt.set(ext, owner);
        added.push(ext);
      }
      return { added, skipped };
    },
    byExtension(ext) {
      const key = ext.toLowerCase();
      const owner = byExt.get(key);
      // 无所有者的扩展名不凭候选接管：未知扩展名仍走 dispatcher 探测链
      if (!owner || !preference) return owner;
      const id = preference(key);
      if (!id || id === owner.id) return owner;
      return candidatesOf(key).find((r) => r.id === id) ?? owner;
    },
    ownerOf: (ext) => byExt.get(ext.toLowerCase()),
    candidatesOf,
    setPreferenceResolver(resolve) {
      preference = resolve;
    },
    byId: (id) => byId.get(id),
    all: () => [...byId.values()]
  };
}
