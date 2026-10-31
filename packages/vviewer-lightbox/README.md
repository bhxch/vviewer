# @bhxch/vviewer-lightbox

零依赖灯箱组件包：body 级单例 overlay——画廊导航（←/→ 环绕）、键盘集、光标锚定
缩放平移（滚轮/按钮/+− 键）、owner 代币防多实例互删。自 render-text 管线迁出的
全自研组件，供任何需要图片/SVG 灯箱的查看器复用。组件只负责 DOM 装配与交互；
样式由宿主按类名约定自备（web 端示例见 `apps/web/src/app.css` 的 `.md-lightbox-*`
规则组，app.css:217-237）。

## 安装

```bash
npm install @bhxch/vviewer-lightbox
```

## 公共导出面（`src/index.ts`）

| 符号 | 说明 |
| --- | --- |
| `collectGallery(root)` | 收集渲染根下画廊条目（img 在前、`.md-diagram-view` 内 svg 在后；跳过 <32px 微缩图与 KaTeX 内 img） |
| `openLightbox(el, ctx, gallery)` | 点击画廊元素打开灯箱：按元素身份定位画廊位置，未命中退化单条 |
| `removeLightboxOverlay(doc, ownerId?)` | 移除 overlay（宿主渲染器 destroy 调用）；传 ownerId 时校验 owner 代币，非 owner 跳过 |
| `clampZoom` / `zoomAt` / `navigate` | 状态机纯函数：缩放限幅（0.2–8）/ 光标锚定缩放 / 画廊环绕导航 |
| `LIGHTBOX_OVERLAY_ID` | overlay 元素 id 常量（`'md-lightbox-overlay'`） |
| `LIGHTBOX_OWNER_ATTR` | owner 代币属性常量（`'data-md-lightbox-owner'`） |
| `GalleryItem` / `LightboxState` / `LightboxCtx` | 类型 |

## 类名与 themeClassPrefix 前缀（公开约定）

组件生成元素的类名走 `md-lightbox-*` 基名 + `ctx.themeClassPrefix` 前缀机制：
前缀非空时输出 `${themeClassPrefix}${base}`（如 `'dark-'` → `.dark-md-lightbox-overlay`）。
该机制是本包公开约定——宿主启用前缀时，样式必须按同规则加前缀写作用域选择器；
不传前缀则为裸基名（web 端当前即裸基名形态）。基名清单：`md-lightbox`（内容 img）、
`md-lightbox-overlay`、`-stage`、`-svg`、`-bar`、`-btn`（及 `-prev/-next/-zoom-in/
-zoom-out/-reset/-close` 变体）、`-count`、`-dragging`。

`LIGHTBOX_OVERLAY_ID` 为 overlay 的 DOM id 常量：宿主生成其它元素 id 应避让该值
（render-text `markdownRenderer.assignHeadingIds` 即消费此常量预填 id 避让集）；
导出剥离/选择器拼接等场景应引用常量而非字面量，防双端漂移。

## owner 代币（多实例防互删）

body 级 overlay 是跨渲染实例的单例：宿主每次 render 生成唯一 token 经
`ctx.lightboxOwner` 传入，`openLightbox` 把「最后打开者」记在 overlay 上；
`removeLightboxOverlay(doc, ownerId)` 只许 owner 随自身 destroy 摘除——多渲染
实例（多 tab）共存时互不删对方正开着的灯箱。不传 ownerId（Esc/点背景等自有关
场景）则无条件移除。

## ctx 最小局部接口（依赖倒置）

`LightboxCtx` 仅含 `themeClassPrefix` / `lightboxOwner` 两个可选字段——实测
`openLightbox`/`cls` 的消费面仅此两项。宿主管线上下文（如 render-text 的
`PipelineCtx`）结构性兼容即可直接传参，类型擦除、无运行时环。

## 发布注意（未来转公开发布时）

- monorepo 态 exports 指 `src/*.ts`（与仓库各包一致，当前 private 无构建）；
  转发布时 build script `tsc` emit 到 dist 并改写 exports/main/types 指向 dist
  （相对形式不变）。零第三方依赖、无资产文件，无需额外拷贝步骤。
- `LIGHTBOX_OVERLAY_ID` / 类名基名是跨端契约面：发布版与宿主样式、导出剥离逻辑
  必须同步演进。

## 仓库与许可

- 仓库：[bhxch/vviewer](https://github.com/bhxch/vviewer)，源码位于 `packages/vviewer-lightbox/`
- 许可：Apache-2.0；第三方依赖许可见仓库 `THIRD_PARTY_NOTICES.md`
