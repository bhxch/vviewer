# 媒体错误兜底设计（BUG-52/53/54 + 动态排序锚解锁）

- 日期：2026-10-16
- 状态：待用户审阅
- 来源：2026-10-10 首轮 e2e 报告定档的 media 域三条 fixme 缺陷 + 2026-10-13 报告 §5.6
  缺口①（「二进制→hex 排前」无 dispatcher 级锚）
- 文中行号为 2026-10-16 HEAD（49cbc26）参考，实施时以符号定位为准。

## 1. 背景与动机

`t-media.spec.ts` 三处 test.fixme（约 :285/:319/:353），均可用文件内既有 File 注入装置构造
载体，无需服务端实例：

- **BUG-52（medium）**：损坏/截断音频（mp3/wav）解码失败后 UI 完全静默——`audio.error`
  已触发（code=4 DEMUXER_ERROR）但 main 区无错误卡片，仅空原生控件。根因
  `packages/render-media/src/av.ts:367-384` 音频分支零 error 监听；卡片装置
  buildActions/showMediaError（视频路径 :436-474）的闭包捕获视频分支状态（art/release/
  cleanups），音频提前 return 面无法直接复用，需上提改造。
- **BUG-53（medium）**：损坏图片 img error 已触发（naturalWidth=0）但无卡片，仅裂图+alt。
  根因 `packages/render-media/src/image.ts:68-69` `img.src = url` 后无监听，render 恒同步
  resolve——错误卡片无从产生（全仓 render-media 无任何 error 监听，rg 零命中已核实）。
- **BUG-54（low）**：video 运行期错误卡片文案恒「未知错误」。根因：ArtPlayer 对 `video:error`
  的处理是「sleep 1s → 重设 url 重连 → 再 emit 'error'」（artplayer.mjs:2495-2501），此刻
  media load 算法已清空 `video.error`，av.ts:477-480 读到的恒 null → 映射表
  `videoErrorMessage`（av.ts:270-278）恒落 default。而 ArtPlayer 转发 `video:error` 事件时
  第一参是**同步捕获的 DOM ErrorEvent**（artplayer.mjs:2467-2471，此刻 error 还在）。

BUG-53 兼是钥匙：image 渲染器改为解码校验失败即 throw 后，损坏二进制图片落
`dispatcher.ts:391` catch → `buildRenderErrorActions:182` 的 `looksTextual` 二分 → 垃圾字节
判非文本 → 「以 hex 打开」排前——**2026-10-13 报告挂账的「动态排序分支无 dispatcher 级
锚」缺口随之自然解锁**（现仅 av 内构按钮顺序间接覆盖）。

## 2. 目标

- T1 BUG-52：音频分支挂 error 监听 → 错误卡片（重试/以 hex 打开），卡片装置上提为双分支
  共享。
- T2 BUG-53：image render 内同步解码校验，失败 throw → dispatcher 卡片（重试/以 hex/
  以纯文本），含超时护栏与异步兜底。
- T3 BUG-54：`video:error` 同步点缓存 MediaError code，映射表文案恢复可达。
- T4 t-media 三条 fixme 转正（docs/e2e/README.md §3.2.4 约定：修复合入 PR 内转正）；
  新增 dispatcher 级动态排序锚用例。
- T5 「探测链结论不参与排序」窄化的知情现状注记（本轮裁决维持现状）。

## 3. 非目标

- 视频首错立即弹卡（改挂 video:error 同步弹卡会改变卡片时机并截断 ArtPlayer 重连时序）。
- 重连豁免（重连预算内不弹卡、瞬时错误自愈）——体验更优但改动大，列为后续独立需求候选。
- 图片加载/解码进度指示、放大缩放增强（attachZoom 现状不动）。
- SVG 路径变化：sanitizeSvg 解析失败 throw → dispatcher 卡片是既有 OWX-02 锚，不动。
- BUG-27/BUG-31（QuickOpen 域，归 e2e 富化第三轮 spec）。

## 4. 设计

### 4.1 BUG-52：音频分支错误兜底

- `buildActions` / `showMediaError` 从视频路径（:436-474）上提为双分支共享 helper（audio
  分支提前 return 之前可见）。视频路径的 `release()`（摘 ArtPlayer/revoke blob/cleanups）
  以回调注入：视频分支传 release，音频分支传等价清理（`el.pause()` + revoke + remove，
  即现 destroy 语义）——两分支均保证「弹卡前先释放播放器实例」，与现状 release 语义一致。
- 音频分支挂 `el.addEventListener('error', ...)` → `showMediaError(videoErrorMessage(...))`
  同款（MediaError code 语义音频视频一致，映射表复用，文案沿用「无法播放此媒体：…」）。
- 动作与视频分支同款：重试（重跑 avRenderer.render，takeOver 级联托管）+ 以 hex 打开
  （getHexFallbackRenderer）。
- 首错收口（cardShown guard）双分支共享，防 onError 重入双弹。

### 4.2 BUG-53：图片同步解码校验 + throw

render() 内、`target.replaceChildren` **之前**插入解码校验（校验失败不污染 DOM）：

1. **主路径**（支持 `img.decode` 的环境）：`await Promise.race([img.decode(), 超时护栏])`。
   decode reject → revoke blob URL → `throw new Error('图片解码失败：' + 简因)` → dispatcher
   catch 卡片。
2. **回退路径**（jsdom / 无 decode 的环境）：feature detect 分流，一次性 `load`/`error`
   事件竞待（Promise 包装 + 同款超时护栏），语义与主路径一致。单测与 jsdom 走此分支。
3. **超时护栏**：decode 挂死（异常大图/畸形编码）时按成功放行（不阻塞查看器），同时保留
   一个迟到 error 监听作**异步兜底**：迟到失败 → 渲染器内构卡（core showErrorCard +
   自备 [重试, 以 hex 打开]，与 av 同款形态；revoke 由该路径接管）。超时值实施时定
   （建议 10s 量级，plan 阶段定档）。
4. throw 形态的收益：错误落 dispatcher 现成机制，动作三件套免费，且垃圾二进制图片使
   `buildRenderErrorActions:182` 走 hex 排前分支——动态排序锚由此解锁（见 §5 e2e）。
5. 正常图片零回归：decode() 对可显示图片不改变渲染结果（浏览器解码缓存，非重复解码）；
   既有图片 e2e（含外域 preload 防线 MD-13）守门。

### 4.3 BUG-54：video:error 缓存 code

- av render 作用域内 `let lastVideoErrCode: number | undefined`；新增
  `art.on('video:error', (event) => { lastVideoErrCode = (event.target as HTMLVideoElement | undefined)?.error?.code })`
  ——ArtPlayer 同步转发点，此刻 `video.error` 尚未被重连清空（artplayer.mjs:2467-2471）。
- 既有 `art.on('error')` 处理器（:477-480）改读
  `videoErrorMessage(lastVideoErrCode ?? art.video?.error?.code)`——缓存优先，直读兜底。
- 时序、卡片时机、ArtPlayer 重连语义全部不动；重连预算内多次 error 时缓存覆盖为最新，
  语义正确。映射表 `videoErrorMessage` 与其单测（av.test.ts:211-215）不动。

## 5. 测试与验收

- **unit（packages/render-media/test/）**：
  - av.test.ts：音频 error 事件 → 卡片可见 + 重试/以 hex 两按钮 + 首错收口不双弹；
    video:error ErrorEvent 提取 code → 卡片文案命中映射表（code=4 → MEDIA_ERR_SRC_NOT_
    SUPPORTED 字样）。
  - renderMedia.test.ts（image）：decode reject → render throw + blob 已 revoke + DOM 未
    污染；jsdom 回退分支（error 事件）同断言；超时放行 → 实例正常返回 + 迟到 error 兜底卡；
    正常图片（load 成功）路径零回归。
- **e2e（apps/web/e2e/）**：
  - t-media.spec.ts 三 fixme 转正：BUG-52 截断 mp3 → `.vv-error-card` 可见 + 两动作按钮；
    BUG-53 垃圾字节 .jpg → 卡片可见 + `.vv-image` 无残留裂图 img；BUG-54 code=4 载体
    （sample.mp4 截断 300B，同 b-media-office-viewer.spec.ts:410 手法）→ 文案含
    MEDIA_ERR_SRC_NOT_SUPPORTED（code=3 载体需 mdat 挖空构造，映射正确性由单测覆盖，
    e2e 仅锚 code=4 一侧）。
  - b-error-card-open-as.spec.ts 新增排序锚：垃圾二进制 .jpg → 卡片动作**第一项**为
    「以 hex 打开」（锁 buildRenderErrorActions:182 二进制→hex 排前分支，与既有 OWX-02
    损坏 SVG → 纯文本排前构成双向锚）。
- 门禁：vitest 全量、playwright 双通道既有锚零翻转（图片/媒体既有用例重点复核）。

## 6. 风险与边界

- `img.decode()` 对个别边缘格式（渐进 JPEG / 特殊 ICC）理论上存在「decode reject 但可降级
  显示」的浏览器差异——按标准语义 reject 即失败；若实测误伤正常图，回退路径（事件判定
  load/error）可整体替换主路径，两分支接口一致。
- 超时放行 + 迟到兜底卡是双路径并存：迟到兜底不走 dispatcher（render 已 resolve），动作
  面较窄（无以纯文本），属超时护栏下的降级体验，注释明示。
- ArtPlayer 版本升级若改变 video:error 转发形态，缓存点失准 → 文案回退「未知错误」（现状
  行为），不会更糟——缓存读取处 `?? art.video?.error?.code` 兜底。

## 7. 裁决记录

- 2026-10-16 用户拍板：BUG-53 取 throw 形态（解锁 dispatcher 排序锚），不取 av 式内构卡；
  BUG-54 取缓存 code 方案（零时序变化），同步弹卡与重连豁免否决（后者列后续候选）；
  「探测链结论参与排序」维持现状（looksTextual 二分），仅做知情注记（T5，落
  docs/e2e/error-card-open-as.md：动态排序 = looksTextual(head) 二分，签名/binary 探测链
  结论不参与排序，SUSP-10 同类口径）。
