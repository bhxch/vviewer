import type { Renderer, RendererId } from '../types';

export class RegistryError extends Error {
  constructor(ext: string, existing: RendererId, incoming: RendererId) {
    super(`扩展名 ".${ext}" 已被 renderer "${existing}" 注册，拒绝 "${incoming}" 重复注册`);
  }
}

export interface Registry {
  install(r: Renderer): void;
  installFallbackExtensions(ownerId: RendererId, exts: readonly string[]): { added: string[]; skipped: string[] };
  byExtension(ext: string): Renderer | undefined;
  byId(id: string): Renderer | undefined;
  all(): Renderer[];
}

export function createRegistry(): Registry {
  const byExt = new Map<string, Renderer>();
  const byId = new Map<string, Renderer>();
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
    byExtension: (ext) => byExt.get(ext.toLowerCase()),
    byId: (id) => byId.get(id),
    all: () => [...byId.values()]
  };
}
