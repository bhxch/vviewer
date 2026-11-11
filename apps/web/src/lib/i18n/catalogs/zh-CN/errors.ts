// catalogs/zh-CN/errors.ts — errors 域目录（Task 7 域 D：core dispatch 错误面
// 兜底文案）。vviewer-core 包保持零 i18n 依赖（依赖方向 apps/web → core 不反转），
// errorMessageOf 的空文案兜底经注入缝（setRenderFailedText，apps/web viewer.ts
// 装配时注入 translate getter）从本目录取值；core 独立消费（无人注入）回落包内
// 英文缺省 'Render failed'（非显示面契约，apps/web 恒注入故渲染输出恒走本目录）。
export const domain = 'errors' as const;

export const messages = {
  'errors.renderFailed': '渲染失败'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
