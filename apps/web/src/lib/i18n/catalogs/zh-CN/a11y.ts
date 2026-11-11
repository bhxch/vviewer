// catalogs/zh-CN/a11y.ts — a11y 域目录（axe/reduceMotion 相关节文案 + D10 渲染
// 边界兜底卡）：减少动效是辅助功能设置（设置中心「语言与辅助功能」节第二控件，
// D11），渲染期未捕获异常兜底卡（svelte:boundary fallback）同属无障碍可用性面。
// 域目录契约（Interfaces 钉死）：key 三段 `{域}.{模块}.{语义}`，satisfies 锁首段。
export const domain = 'a11y' as const;

export const messages = {
  // —— 减少动效（a11y.reduceMotion.*，D11：设置项三态 system/on/off）——
  'a11y.reduceMotion.label': '减少动效',
  'a11y.reduceMotion.system': '跟随系统',
  'a11y.reduceMotion.on': '减弱',
  'a11y.reduceMotion.off': '照常',
  'a11y.reduceMotion.hint':
    '「减弱」将辅助动效压至瞬时（toast 瞬显、闪烁省略，滚动定位不受影响）；「跟随系统」按系统减少动效偏好解析。',

  // —— 渲染边界兜底卡（a11y.boundary.*，D10：fallback 复用错误卡视觉类名）——
  'a11y.boundary.title': '页面渲染出现异常',
  'a11y.boundary.detail': '渲染期发生未捕获异常：{message}',
  'a11y.boundary.reload': '重载'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
