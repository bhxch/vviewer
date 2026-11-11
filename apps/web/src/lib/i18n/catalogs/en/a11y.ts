// catalogs/en/a11y.ts — a11y 域 en 目录（D15：全量覆盖，插值占位符与 zh 一致）。
export const domain = 'a11y' as const;

export const messages = {
  // —— 减少动效（a11y.reduceMotion.*，D11）——
  'a11y.reduceMotion.label': 'Reduce motion',
  'a11y.reduceMotion.system': 'Follow system',
  'a11y.reduceMotion.on': 'Reduce',
  'a11y.reduceMotion.off': 'Normal',
  'a11y.reduceMotion.hint':
    '"Reduce" makes auxiliary animations instant (toasts appear instantly, flashes omitted; scroll positioning unaffected); "Follow system" follows the OS reduce-motion preference.',

  // —— 渲染边界兜底卡（a11y.boundary.*，D10）——
  'a11y.boundary.title': 'Page rendering failed',
  'a11y.boundary.detail': 'An uncaught error occurred while rendering: {message}',
  'a11y.boundary.reload': 'Reload'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
