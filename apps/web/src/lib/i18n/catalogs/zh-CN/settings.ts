// catalogs/zh-CN/settings.ts — settings 域目录（Task 3 新设置节首批消费者：「语言
// 与辅助功能」节 + 设置中心左导航组名）。域目录契约（Interfaces 钉死）：key 三段
// `{域}.{模块}.{语义}`，satisfies 锁首段；Task 7（域 C 设置中心）抽取时向本文件
// 追加既有节文案，zh 值与被移除字面量逐字节等价（D7）。
export const domain = 'settings' as const;

export const messages = {
  // —— 左导航组名（settings.nav.*）——
  'settings.nav.languageA11y': '语言与辅助功能',

  // —— 「语言与辅助功能」节 · 界面语言（settings.language.*）——
  'settings.language.label': '界面语言',
  'settings.language.zhCN': '简体中文',
  'settings.language.en': 'English',
  'settings.language.hint': '界面文案与 git 日期格式随所选语言显示，「应用」后生效。'
} as const satisfies Record<`${typeof domain}.${string}`, string>;
