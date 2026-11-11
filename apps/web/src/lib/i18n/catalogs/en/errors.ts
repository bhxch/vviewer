// catalogs/en/errors.ts — errors 域 en 目录（D15：全量覆盖，占位符与 zh 一致）。
export const domain = 'errors' as const;

export const messages = {
  'errors.renderFailed': 'Render failed'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
