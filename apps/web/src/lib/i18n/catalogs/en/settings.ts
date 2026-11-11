// catalogs/en/settings.ts — settings 域 en 目录（D15：全量覆盖为交付目标，插值
// 占位符与 zh 一致，聚合机检锁键集/占位符逐 key 相等）。语言名走原生名惯例
// （en 目录中「简体中文」选项仍显示「简体中文」）。
export const domain = 'settings' as const;

export const messages = {
  // —— 左导航组名（settings.nav.*）——
  'settings.nav.languageA11y': 'Language & accessibility',

  // —— 「语言与辅助功能」节 · 界面语言（settings.language.*）——
  'settings.language.label': 'Interface language',
  'settings.language.zhCN': '简体中文',
  'settings.language.en': 'English',
  'settings.language.hint':
    'UI text and git date formats follow the selected language; takes effect on "Apply".'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
