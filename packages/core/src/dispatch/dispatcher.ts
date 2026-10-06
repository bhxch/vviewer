import type { Detection, FileSource, RenderedInstance, RendererId } from '../types';
import type { Registry } from '../registry/registry';
import { detect } from '../detect';
import { errorRenderer, showErrorCard } from './errorRenderer';

export interface Dispatcher {
  dispatch(source: FileSource, buffer: Uint8Array, target: HTMLElement):
    Promise<{ instance: RenderedInstance; rendererId: RendererId; det: Detection }>;
}

const HEAD_SIZE = 8192;
const FULL_LIMIT = 1 << 20;

export function createDispatcher(registry: Registry): Dispatcher {
  return {
    async dispatch(source, buffer, target) {
      const head = buffer.slice(0, HEAD_SIZE);
      const det = detect({ name: source.name, head, full: buffer.length <= FULL_LIMIT ? buffer : undefined });
      let renderer = registry.byExtension(det.ext);
      try {
        if (!renderer) throw new Error(`不支持的扩展名 ".${det.ext}"`);
        let redirected = false;
        if (renderer.sniff) {
          const to = await renderer.sniff(head, det);
          if (to && to !== renderer.id) {
            const next = registry.byId(to);
            if (next) { redirected = true; renderer = next; }
          }
        }
        if (redirected && renderer.sniff) await renderer.sniff(head, det); // 允许最终 renderer 补充 sniff 元数据，但不再改派
        const instance = await renderer.render(buffer, target, source, det);
        return { instance, rendererId: renderer.id, det };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const instance = showErrorCard(target, message, source);
        return { instance, rendererId: errorRenderer.id, det };
      }
    }
  };
}
