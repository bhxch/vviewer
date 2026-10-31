// index.ts — @bhxch/vviewer-lightbox 包根导出面：零依赖灯箱组件（画廊收集 / 键盘集 /
// 光标锚定缩放平移 / owner 代币防互删），自 render-text 管线迁出的全自研组件。
// 跨包消费一律经包根 import（含主应用改造点所需的全部符号：
// collectGallery/openLightbox/removeLightboxOverlay/LIGHTBOX_OVERLAY_ID/LIGHTBOX_OWNER_ATTR）。
export {
  clampZoom,
  collectGallery,
  LIGHTBOX_OVERLAY_ID,
  LIGHTBOX_OWNER_ATTR,
  navigate,
  openLightbox,
  removeLightboxOverlay,
  zoomAt,
  type GalleryItem,
  type LightboxCtx,
  type LightboxState,
} from './lightbox';
