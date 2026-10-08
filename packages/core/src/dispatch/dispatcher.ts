import type { Detection, FileSource, RenderedInstance, Renderer, RendererId } from '../types';
import type { Registry } from '../registry/registry';
import { detect } from '../detect';
import { looksTextual, shebangLangOf } from '../detect/magic';
import {
  errorRenderer,
  getHexFallbackRenderer,
  setHexFallbackRenderer,
  showErrorCard,
  type ErrorCardAction
} from './errorRenderer';

export interface Dispatcher {
  dispatch(source: FileSource, buffer: Uint8Array, target: HTMLElement):
    Promise<{ instance: RenderedInstance; rendererId: RendererId; det: Detection }>;
}

const HEAD_SIZE = 8192;
const FULL_LIMIT = 1 << 20;

/** 签名 → 规范改派目标（BUG-13 与 BUG-07 无扩展名回退链共用的改派表）。
 * ole 无专用渲染器不改派（维持 hex 语义）；mpegts 规范扩展名 'ts'
 * （av 渲染器按 det.ext 分派 video 形态与 mpegts loader，故改派需同步纠偏 ext）。 */
export interface SignatureRoute {
  rendererId: RendererId;
  ext: string;
}

const SIGNATURE_ROUTES: Partial<Record<NonNullable<Detection['signature']>, SignatureRoute>> = {
  zip: { rendererId: 'archive', ext: 'zip' },
  png: { rendererId: 'image', ext: 'png' },
  jpeg: { rendererId: 'image', ext: 'jpg' },
  gif: { rendererId: 'image', ext: 'gif' },
  pdf: { rendererId: 'pdf', ext: 'pdf' },
  mpegts: { rendererId: 'av', ext: 'ts' }
};

/** 签名的规范改派目标；无签名或无路由签名（ole）返回 null */
export function signatureRouteOf(signature: Detection['signature']): SignatureRoute | null {
  if (!signature) return null;
  return SIGNATURE_ROUTES[signature] ?? null;
}

/** 文本类渲染器：仅它们参与「签名与扩展名不符 → 改派」的 magic 预检（BUG-13 裁决口径：
 * 非文本类渲染器一律不参与——.zip 扩展名 + PNG 签名由 archive 自身「无法识别的压缩包格式」
 * 错误卡片兜底，语义正确；与 ooxml 渲染器「sniff 永不改派」的既有裁决同向）。 */
const TEXTUAL_RENDERER_IDS = new Set<RendererId>(['code', 'markdown', 'html']);

/** 渲染阶段失败错误卡片的动作（BUG-14）：重试 = 重跑本渲染器 render；降级 = hex 渲染原始字节。
 * onRendered 接收重试/降级成功产出的实例，由调用方（dispatch catch）级联托管 */
function buildRenderErrorActions(
  renderer: Renderer,
  buffer: Uint8Array,
  source: FileSource,
  det: Detection,
  target: HTMLElement,
  onRendered: (instance: RenderedInstance) => void
): ErrorCardAction[] {
  const retry = (): void => {
    renderer.render(buffer, target, source, det)
      .then(onRendered)
      .catch((err: unknown) => {
        // 重试仍失败：保留错误详情，按钮随之重建（可继续重试/降级）
        const message = err instanceof Error ? err.message : String(err);
        showErrorCard(target, message, source, {
          actions: buildRenderErrorActions(renderer, buffer, source, det, target, onRendered)
        });
      });
  };
  const actions: ErrorCardAction[] = [{ label: '重试', onClick: retry }];
  const hex = getHexFallbackRenderer();
  if (hex) {
    actions.push({
      label: '降级查看',
      onClick: () => {
        Promise.resolve(hex.render(buffer, target, source, det))
          .then(onRendered)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            showErrorCard(target, message, source);
          });
      }
    });
  }
  return actions;
}

/**
 * 统一选路：扩展名主路由 → 无扩展名回退链（签名改派 → 文本性探测 + shebang，BUG-07）
 * → 文本类渲染器的 magic 签名预检改派（BUG-13）。会按改派结果原地纠偏 det.ext，
 * 并在 extless 文本命中时写 det.extless 与 det.lang（shebang 语言，供 code 渲染器消费）。
 */
function resolveInitialRenderer(
  initial: Renderer | undefined,
  det: Detection,
  head: Uint8Array,
  registry: Registry
): Renderer | undefined {
  let renderer = initial;
  if (!renderer && det.ext === '') {
    // ① 签名改派（与 BUG-13 同表）：无扩展名但有强签名（PK/PNG/PDF/…）直接进规范渲染器
    const route = signatureRouteOf(det.signature);
    if (route) {
      const next = registry.byId(route.rendererId);
      if (next) {
        renderer = next;
        det.ext = route.ext; // 纠偏：渲染器内部按 ext 分派（av 的 ts → mpegts loader 等）
      }
    }
    // ② 文本性探测 → code 渲染器 + shebang 语言识别（detectLanguage 的窄表实现）
    if (!renderer && looksTextual(head)) {
      const code = registry.byId('code');
      if (code) {
        renderer = code;
        det.extless = true;
        det.lang = shebangLangOf(new TextDecoder().decode(head)) ?? undefined;
      }
    }
    // ③ 皆不命中：返回 undefined，由调用方抛特化文案（不再出现 `""` 字样）
  }
  if (renderer && TEXTUAL_RENDERER_IDS.has(renderer.id)) {
    // BUG-13 magic 预检（在 renderer.sniff 之前）：文本类渲染器 + 已识别签名不符 → 改派一次；
    // 只重定向一次的总语义由既有 redirected 机制保证（改派后的 renderer.sniff 返回值不再改派）
    const route = signatureRouteOf(det.signature);
    if (route && route.rendererId !== renderer.id) {
      const next = registry.byId(route.rendererId);
      if (next) {
        renderer = next;
        det.ext = route.ext;
      }
    }
  }
  return renderer;
}

export function createDispatcher(registry: Registry): Dispatcher {
  // hex 降级渲染器注册（BUG-14）：av 渲染器运行期错误卡片的「降级查看」经 core getter 消费，
  // render-media 不反向依赖 render-binary（避免包间耦合）；重复 createDispatcher 时后者覆盖
  setHexFallbackRenderer(registry.byId('hex') ?? null);
  return {
    async dispatch(source, buffer, target) {
      const head = buffer.slice(0, HEAD_SIZE);
      const det = detect({ name: source.name, head, full: buffer.length <= FULL_LIMIT ? buffer : undefined });
      let renderer = registry.byExtension(det.ext);
      try {
        renderer = resolveInitialRenderer(renderer, det, head, registry);
        if (!renderer) {
          // 选路失败时 det.ext 必为 ''（extless 回退链未命中）或非空未知扩展名
          throw new Error(
            det.ext === ''
              ? '不支持的文件类型（无扩展名且无法识别内容）'
              : `不支持的扩展名 ".${det.ext}"`
          );
        }
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
        // 仅 render 阶段失败提供重试/降级（选路失败重试同一路径无意义，保持纯错误卡片）。
        // 重试/降级成功产出的真实实例由 liveChild 级联托管：调用方（ViewerPane）持有的
        // live 仍是本卡片实例，其 destroy（tab 关闭/重渲染）时级联释放，杜绝资源泄漏
        let liveChild: RenderedInstance | null = null;
        const takeOver = (instance: RenderedInstance): void => {
          liveChild?.destroy(); // 同一插槽先释放上一个成功实例（重试/降级互斥替换语义）
          liveChild = instance;
        };
        const actions = renderer
          ? { actions: buildRenderErrorActions(renderer, buffer, source, det, target, takeOver) }
          : undefined;
        const card = showErrorCard(target, message, source, actions);
        return {
          instance: {
            destroy() {
              liveChild?.destroy();
              card.destroy();
            }
          },
          rendererId: errorRenderer.id,
          det
        };
      }
    }
  };
}
