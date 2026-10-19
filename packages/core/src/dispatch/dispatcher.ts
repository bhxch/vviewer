import type { ByteRange, Detection, FileSource, LineMetrics, RenderedInstance, Renderer, RendererId, StreamCtx } from '../types';
import type { Registry } from '../registry/registry';
import { detect } from '../detect';
import { looksTextual, shebangLangOf } from '../detect/magic';
import {
  errorRenderer,
  setHexFallbackRenderer,
  showErrorCard,
  type ErrorCardAction
} from './errorRenderer';
import { classifyDispatchError, DispatchReadError } from './errors';

export interface Dispatcher {
  dispatch(
    source: FileSource,
    buffer: Uint8Array<ArrayBuffer> | null,
    target: HTMLElement,
    opts?: DispatchOptions
  ): Promise<{ instance: RenderedInstance; rendererId: RendererId; det: Detection }>;
}

/** dispatch 级流式读闭包（io-streaming §3）：range 缺省 = 全量读；range 的 end 含
 * （同 ByteRange 语义）。可选 signal：渲染实例 destroy 时取消在飞读（流式硬化）。
 * 由调用方以 store.read 绑定（Task 4 ViewerPane 接线）。 */
export type DispatchRead = (range?: ByteRange, signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;

/** dispatch 可选项（C 项：手选打开方式；io-streaming §3：流式读） */
export interface DispatchOptions {
  /** 渲染器 override：命中 registry.byId 即用——用户显式选择 ≠ 内容识别，
   * 跳过探测链（resolveInitialRenderer）与 BUG-13 magic 预检，且不置
   * reclassifiedFrom（改派语义只属于自动识别）；id 未命中静默走正常链。 */
  rendererOverride?: RendererId;
  /** 流式读闭包：buffer === null 时必填（全量字节不预取，head 探测与按需读都经它）；
   * buffer 直传（兼容路径）时省略，dispatch 不触发任何 store 读。 */
  read?: DispatchRead;
  /** render 级取消 signal（审计 R1 I-1）：透传为 render 第 6 参——超时/异步渲染器
   * 的迟到落定校验（image 解码窗）aborted 即快速失败，由本 catch 的 abort 分类
   * 接管（no-op 不上屏）。缺省不传第 6 参，渲染器侧零感知。 */
  signal?: AbortSignal;
  /** 行尺度（字体系统 spec §3，Task 2）：并入 render 第 6 参透传——code/hex 以之
   * 替换行高常量（虚拟滚动装配/行占位/跳转坐标），其余渲染器不读即零感知。 */
  lineMetrics?: LineMetrics;
}

const HEAD_SIZE = 8192;
const FULL_LIMIT = 1 << 20;

/**
 * 补拉全量后的编码精判（终审 F2 及其渲染器侧镜像的共享 helper，I-2 收口）：
 * size 未知/超限时 det 仅由 8KB head 短样本判编码（截断多字节序列可误判 gb18030），
 * 全量到手后以 full 重算 detect 并只把 encoding/binary 两字段合并回 det（原地变更，
 * 无返回值——调用点少一行即少一次遗漏面）。只合并这两字段：ext/signature 等已被
 * sniff/改派阶段纠偏（签名改派/extless/lang），整对象替换会回退纠偏；head/name 未变
 * → 其余字段复算值与初算一致（detect 纯函数可重入）。凡「补拉全量后解码」的入口
 * （本文件两处 + 渲染器守卫补拉）一律经此，防第五次遗漏。
 */
export function redetectWithFull(
  source: FileSource,
  head: Uint8Array,
  full: Uint8Array,
  det: Detection
): void {
  const redet = detect({ name: source.name, head, full });
  det.encoding = redet.encoding;
  det.binary = redet.binary;
}

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

/** 错误卡片 open-as 动作的重入闭包：同一 source/buffer/target 以新 opts 重派 dispatch */
type Redisplay = (
  opts?: DispatchOptions
) => Promise<{ instance: RenderedInstance; rendererId: RendererId; det: Detection }>;

/** 「以纯文本/以 hex 打开」（C 项）：onClick 以 rendererOverride 重入 dispatch——与
 * TopBar 手选打开方式同一语义（显式选择 ≠ 内容识别，不走探测链）。重入产出的实例
 * （含重入自身失败时的错误卡片复合实例）经 onRendered 级联托管：外层卡片销毁
 * （tab 关闭/重渲染）时一并释放，杜绝资源泄漏。 */
function openAsAction(
  id: RendererId,
  label: string,
  redisplay: Redisplay,
  onRendered: (instance: RenderedInstance) => void
): ErrorCardAction {
  return {
    label,
    onClick: () => {
      // 重入链补 .catch：detect/buffer.slice 在 dispatch try 块外，极低概率 reject
      // （unhandled rejection）；失败时保留原错误卡片（用户可改选其他方式），仅记录
      void redisplay({ rendererOverride: id })
        .then((r) => onRendered(r.instance))
        .catch((err: unknown) => {
          // 取消不属「重入失败」（错误身份与字节映射 Task 2）：不留 error 级痕
          if (classifyDispatchError(err) === 'abort') return;
          console.error('[vviewer] open-as 重入失败', err);
        });
    }
  };
}

/**
 * 渲染阶段失败错误卡片的动作（BUG-14 + C 项）：重试 = 重跑本渲染器 render；
 * 「以纯文本/以 hex 打开」= rendererOverride 重入 dispatch（取代原「降级查看」直调
 * hex.render——label 更明确且与手选打开方式同语义）。open-as 按 looksTextual 探测排序
 * （判文本 → 纯文本在前，否则 hex 在前）；当前 renderer 即 hex 时不重复给 hex。
 * streaming 渲染器重试须透传 ctx（io-streaming Task 5 评审指令②）：以原 base +
 * ctx 重跑 render，字节经 ctx.read 重读（opts.read 链）——缺省第 5 参会以裸 probe
 * 重跑，streaming 渲染器必次次失败。renderOpts（signal + lineMetrics）透传为
 * render 第 6 参（审计 R1：重试/open-as 重入与主路径同获取消信号，同型解码盲窗
 * 收口；字体系统 Task 2：重试同样保行尺度）。onRendered 接收重试/open-as 成功
 * 产出的实例，由调用方（dispatch catch）级联托管。
 */
function buildRenderErrorActions(
  registry: Registry,
  renderer: Renderer,
  buffer: Uint8Array,
  source: FileSource,
  det: Detection,
  target: HTMLElement,
  onRendered: (instance: RenderedInstance) => void,
  redisplay: Redisplay,
  ctx?: StreamCtx,
  renderOpts?: { signal?: AbortSignal; lineMetrics?: LineMetrics }
): ErrorCardAction[] {
  const retry = (): void => {
    renderer.render(buffer, target, source, det, ctx, renderOpts)
      .then(onRendered)
      .catch((err: unknown) => {
        // 取消 ≠ 重试失败（错误身份与字节映射 Task 2，与主 catch「abort 不上屏」
        // 同裁决）：重试被取消时原卡保留在屏，不以「读取已取消」重画
        if (classifyDispatchError(err) === 'abort') return;
        // 重试仍失败：保留错误详情，按钮随之重建（可继续重试/以其他方式打开）
        const message = err instanceof Error ? err.message : String(err);
        showErrorCard(target, message, source, {
          actions: buildRenderErrorActions(registry, renderer, buffer, source, det, target, onRendered, redisplay, ctx, renderOpts)
        });
      });
  };
  const actions: ErrorCardAction[] = [{ label: '重试', onClick: retry }];
  const text = registry.byId('code')
    ? openAsAction('code', '以纯文本打开', redisplay, onRendered)
    : null;
  const hex = registry.byId('hex') && renderer.id !== 'hex'
    ? openAsAction('hex', '以 hex 打开', redisplay, onRendered)
    : null;
  for (const action of looksTextual(buffer.slice(0, HEAD_SIZE)) ? [text, hex] : [hex, text]) {
    if (action) actions.push(action);
  }
  return actions;
}

/**
 * 选路失败（renderer undefined）错误卡片的动作（C 项）：无重试（同一路径重试无意义），
 * [以纯文本打开, 以 hex 打开]；未注册对应渲染器即省略该按钮（hex 缺失只给文本——
 * 选路失败时 hex 必未注册，hex 分支实为防御性对齐通用语义）。
 */
function buildRoutingErrorActions(
  registry: Registry,
  onRendered: (instance: RenderedInstance) => void,
  redisplay: Redisplay
): ErrorCardAction[] {
  const actions: ErrorCardAction[] = [];
  if (registry.byId('code')) actions.push(openAsAction('code', '以纯文本打开', redisplay, onRendered));
  if (registry.byId('hex')) actions.push(openAsAction('hex', '以 hex 打开', redisplay, onRendered));
  return actions;
}

/**
 * 统一选路：扩展名主路由 → 内容探测回退链（签名改派 → 文本性探测 + shebang，BUG-07
 * 原生无扩展名；C 项放宽为未知扩展名同样探测，链尾追加 hex 兜底）
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
  if (!renderer) {
    // C 项：未知扩展名不再直接报错——与原生无扩展名（BUG-07）同走内容探测链，链尾 hex 兜底
    const originalExt = det.ext;
    // ① 签名改派（与 BUG-13 同表）：有强签名（PK/PNG/PDF/…）直接进规范渲染器
    const route = signatureRouteOf(det.signature);
    if (route) {
      const next = registry.byId(route.rendererId);
      if (next) {
        renderer = next;
        det.ext = route.ext; // 纠偏：渲染器内部按 ext 分派（av 的 ts → mpegts loader 等）
        // 仅「有扩展名但被改派」置位；原生无扩展名的签名纠偏不算改派
        if (originalExt !== '' && route.ext !== originalExt) det.reclassifiedFrom = originalExt;
      }
    }
    // ② 文本性探测 → code 渲染器 + shebang 语言识别（detectLanguage 的窄表实现）；
    // extless 语义收窄：仅原生无扩展名文件置位（既有 e2e 断言依赖）
    if (!renderer && looksTextual(head)) {
      const code = registry.byId('code');
      if (code) {
        renderer = code;
        if (originalExt === '') {
          det.extless = true;
        } else {
          det.reclassifiedFrom = originalExt;
        }
        det.lang = shebangLangOf(new TextDecoder().decode(head)) ?? undefined;
      }
    }
    // ③ hex 兜底（C 项）：签名/文本皆不命中的未知扩展名（或无扩展名）内容落 hex 查看器
    if (!renderer) {
      const hex = registry.byId('hex');
      if (hex) {
        renderer = hex;
        if (originalExt !== '') det.reclassifiedFrom = originalExt;
      }
    }
    // ④ 皆不命中：返回 undefined，由调用方抛特化文案（不再出现 `""` 字样）
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
  // hex 降级渲染器注册（BUG-14）：av 渲染器运行期错误卡片的「以 hex 打开」经 core getter 消费，
  // render-media 不反向依赖 render-binary（避免包间耦合）；重复 createDispatcher 时后者覆盖
  setHexFallbackRenderer(registry.byId('hex') ?? null);
  const dispatch = async (
    source: FileSource,
    buffer: Uint8Array<ArrayBuffer> | null,
    target: HTMLElement,
    opts?: DispatchOptions
  ): Promise<{ instance: RenderedInstance; rendererId: RendererId; det: Detection }> => {
    const read = opts?.read;
    // 流式读下沉（io-streaming §3）：buffer === null = 全量字节不预取、按需经 read；
    // 两者皆缺 = 调用方违约（内容不可得，错误卡片无从构造），直接拒绝。
    // 读失败在此 try 块外的 probe/full 拉取处 reject（与旧 ViewerPane 先 store.read 的
    // 失败面一致，由调用方既有的读取失败卡片承接），不进下方渲染错误卡片
    if (buffer === null && read === undefined) throw new Error('dispatch 需要 buffer 或 opts.read');
    // 读策略（io-streaming §3）：buffer 直传 = 兼容路径（full 即 buffer，零重复读）；
    // buffer === null 且 size 已知且 ≤1MB → 直接全量（保 detect 的 full 编码精判，与旧
    // 「full: buffer.length <= FULL_LIMIT」语义一致）；size 未知或超限 → 先 head 探测
    let full: Uint8Array<ArrayBuffer> | null = buffer;
    let probe: Uint8Array<ArrayBuffer>;
    const headOnly = buffer === null;
    if (buffer === null) {
      const size = source.size ?? null;
      if (size !== null && size <= FULL_LIMIT) full = await read!();
      probe = full ?? (await read!({ start: 0, end: HEAD_SIZE - 1 }));
    } else {
      probe = buffer;
    }
    const head = probe.slice(0, HEAD_SIZE);
    const det = detect({ name: source.name, head, full: full !== null && full.length <= FULL_LIMIT ? full : undefined });
    // C 项：override 先于 byExtension 拦截：命中即用；id 未命中静默走正常探测链
    const override = opts?.rendererOverride === undefined ? undefined : registry.byId(opts.rendererOverride);
    // C 项：错误卡片 open-as 动作的重入闭包（同一 source/buffer/target 重派）。
    // read 透传：headOnly 时重入同样以 null+read 走流式读；兼容路径保持 buffer 直传不变。
    // 审计 R1：重试/open-as 重入与主路径同获取消信号（同型解码盲窗收口）
    const optsSignal = opts?.signal;
    // render 第 6 参（审计 R1 + 字体系统 Task 2）：signal 与 lineMetrics 同参异构
    // 字段；双侧缺省维持「不传第 6 参」调用形态（渲染器侧零感知，向后兼容）
    const renderOpts: { signal?: AbortSignal; lineMetrics?: LineMetrics } | undefined =
      opts?.signal || opts?.lineMetrics
        ? { signal: opts.signal, lineMetrics: opts.lineMetrics }
        : undefined;
    const redisplay: Redisplay = (o) =>
      headOnly
        ? dispatch(source, null, target, { ...o, signal: optsSignal, read })
        : dispatch(source, buffer, target, { ...o, signal: optsSignal });
    let renderer: Renderer | undefined;
    // 渲染期 ctx（streaming 分支构造）：声明在 try 外——catch 的重试动作需要透传
    //（评审指令②），try 作用域变量 catch 不可见
    let renderCtx: StreamCtx | undefined;
    // 延迟全量读统一包装（headOnly 不变量保证此处 read 已定义）：失败标 DispatchReadError
    // （单源见 ./errors），由下方 catch 识别后向上 reject，不落渲染错误卡片；
    // open-as 重入路径同样 reject，经 openAsAction 既有 .catch 保留原错误卡片
    const readFull = (): Promise<Uint8Array<ArrayBuffer>> =>
      read!().catch((err: unknown) => {
        throw new DispatchReadError(err);
      });
    try {
      if (override) {
        // override 路径：用户显式选择 ≠ 内容识别——不经过 resolveInitialRenderer
        // （签名改派/文本探测/hex 兜底，因而不置 reclassifiedFrom）与 BUG-13 预检；
        // sniff 仅作元数据补齐（ooxml 族依赖），返回的改派建议被忽略——显式选择不被推翻
        renderer = override;
        if (override.sniff) await override.sniff(head, det);
      } else {
        renderer = resolveInitialRenderer(registry.byExtension(det.ext), det, head, registry);
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
      }
      if (!renderer.streaming) {
        // 非 streaming 渲染器：全量 buffer 交付（旧行为，第 5 参不传）。兼容路径 full
        // 即入参 buffer（零重复读）；headOnly 且 size 未知/超限时此处补一次全量 read
        // （headOnly 不变量保证 read 已定义）
        if (full === null) {
          full = await readFull();
          // 终审 F2：headOnly（size 未知）时 det 仅以 8KB head 短样本判编码（旧
          // 「≤1MB full 精判」退化面）——全量到手后重算恢复精判（共享 helper 见
          // redetectWithFull doc）。streaming 分支不动（io-streaming 计划 2 处理）。
          redetectWithFull(source, head, full, det);
        }
        // 第 6 参透传（审计 R1 I-1）：render 级取消 signal——异步渲染器的迟到落定
        // （如 image 解码 await 窗）据此快速失败，abort 身份经下方 catch no-op 不上屏；
        // lineMetrics（字体系统 Task 2）同参透传给 code/hex
        const instance = await renderer.render(full, target, source, det, undefined, renderOpts);
        return { instance, rendererId: renderer.id, det };
      }
      // streaming 渲染器（io-streaming §2.2）：只交付 head + StreamCtx（render 第 5 参），
      // 不交付全量 buffer。store 无 range 能力（含兼容路径 read 缺省的 buffer 直传）→
      // 先全量 read，ctx 退化为全量切片视图（零拷贝 subarray）
      const capable = source.store.rangeCapable === true && read !== undefined;
      if (!capable && full === null) {
        full = await readFull();
        // 终审 F2 镜像（T4 评审指令）：headOnly（size 未知/超限）streaming 降级路径的
        // det 同样仅以 8KB head 短样本判编码——降级全量到手后重算回填（openUrl 打开
        // url jsonl 可达；head 误判 utf-8 时尾部 mojibake）。共享 helper 见其 doc。
        redetectWithFull(source, head, full, det);
      }
      // buffer 形参 = full ?? probe：capable 且 size 未知/超限 → head 探测块；否则全量
      const base = full ?? probe;
      renderCtx = capable
        ? {
          size: source.size ?? null,
          head: probe,
          // 渲染期按需读失败与 Task 4 DispatchReadError 同口径（io-streaming Task 5
          // 评审指令①）：失败标为读错误向上直抛调用方读取失败面（dispatch catch 识别
          // 后 rethrow，无重试通道）——渲染器 await 它的路径（如 hex size 回退全量读）
          // 不会落「错误卡片 + 8KB probe 重试」的截断活面；渲染器自行 catch 的按需读
          //（如 hex 窗口 ensure）收到的也是已标记读失败，走自兜底而非错误重试。
          // 例外（流式硬化）：signal.aborted 时的 reject 是 destroy 取消而非读失败，
          // 原样透传不标 DispatchReadError——取消不该落错误卡片/触发重试
          read: (r, signal) =>
            read!(r, signal).catch((err: unknown): never => {
              if (signal?.aborted) throw err; // destroy 取消：非读失败，不标 DispatchReadError
              throw new DispatchReadError(err);
            })
        }
        : { size: base.length, head: base, read: async (r) => base.subarray(r.start, r.end + 1) };
      const instance = await renderer.render(base, target, source, det, renderCtx, renderOpts);
      return { instance, rendererId: renderer.id, det };
    } catch (err) {
      const kind = classifyDispatchError(err);
      // 读失败 ≠ 渲染失败（T3 评审）：重跑 render 无意义且 catch 手头只有 8KB head
      // 探测块（headOnly 时）——重试会静默截断渲染。向上 reject 走调用方读取失败面。
      if (kind === 'read') throw err;
      // abort 不上屏（deferred 清偿 Task 5 裁决）：effect 级取消（ViewerPane
      // effectAbort）使「AbortError 经 render 冒泡」可达——取消不是渲染失败：不落
      // 错误卡片（DOM 即将被新一轮渲染接管，卡片只会闪现/滞留），返回 no-op 实例，
      // 调用方既有 cancelled 面将其丢弃（cleanup 晚于 resolve 的形态由实例级
      // controller 兜底，不再冒泡至此）
      if (kind === 'abort') {
        return { instance: { destroy() {} }, rendererId: errorRenderer.id, det };
      }
      const message = err instanceof Error ? err.message : String(err);
      // render 失败提供重试 + open-as（选路失败无重试，只给 open-as 换打开方式）。
      // 重试/open-as 成功产出的真实实例由 liveChild 级联托管：调用方（ViewerPane）持有的
      // live 仍是本卡片实例，其 destroy（tab 关闭/重渲染）时级联释放，杜绝资源泄漏
      let liveChild: RenderedInstance | null = null;
      const takeOver = (instance: RenderedInstance): void => {
        liveChild?.destroy(); // 同一插槽先释放上一个成功实例（重试/open-as 互斥替换语义）
        liveChild = instance;
      };
      // open-as 排序与重试复用的字节：full ?? probe（旧 buffer 语义）。兼容路径即入参
      // buffer；headOnly 时退化为 head 探测块——渲染在全量拉取前已失败，以 head 判
      // looksTextual 足够近似且零额外读（可接受的退化，非旧行为回归面）
      const actions = renderer
        ? { actions: buildRenderErrorActions(registry, renderer, full ?? probe, source, det, target, takeOver, redisplay, renderCtx, renderOpts) }
        : { actions: buildRoutingErrorActions(registry, takeOver, redisplay) };
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
  };
  return { dispatch };
}
