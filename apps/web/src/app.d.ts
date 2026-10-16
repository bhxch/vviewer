/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** 构建期注入的 grammar CDN 层 base（须以 /grammars/ 结尾；缺省=无 CDN 层，ledger H3） */
  readonly VV_GRAMMAR_CDN?: string;
}

declare global { namespace App {} }
export {};
