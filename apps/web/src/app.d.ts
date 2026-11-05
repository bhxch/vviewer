/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** 构建期注入的 grammar CDN 层 base（须以 /grammars/ 结尾；缺省=无 CDN 层，ledger H3） */
  readonly VV_GRAMMAR_CDN?: string;
  /** 构建期注入的 foreign 资产 env 显式层 base（spec §6.2 计划 3 Task 3：自托管
   * asset-installer 合并树根，尾斜杠归一在 resolveForeignAssetBase；空=缺省 CDN 层） */
  readonly VV_FOREIGN_ASSETS?: string;
}

declare global { namespace App {} }
export {};
