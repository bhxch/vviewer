// check-unresolved-imports.mjs — 产物图可审计门（spec §5「esbuild 产物无未解析 import」）。
//
// 纪律：构建期 esbuild 默认对未解析 import 直接报错（唯一 external 白名单 = host bundle 的
// `vscode`；svgbob 路径走条件桩，不进 external 名单）——本脚本把「构建期不炸」升级为
// **产物图可审计**：扫 metafile 的 `outputs[].imports`，断言无 `external: true` 残留。

/**
 * 扫 metafile 找未解析（external）import。
 * @param {{outputs: Record<string, {imports?: Array<{path: string, kind?: string, external?: boolean}>}>}} metafile
 * @param {string[]} allowedExternals 豁免名单（host bundle 的 vscode）
 */
export function findUnresolvedImports(metafile, allowedExternals = []) {
  const out = [];
  const outputs = metafile?.outputs ?? {};
  for (const [file, info] of Object.entries(outputs)) {
    for (const imp of info.imports ?? []) {
      if (imp.external && !allowedExternals.includes(imp.path)) {
        out.push({ file, path: imp.path, kind: imp.kind });
      }
    }
  }
  return out;
}

/** 断言产物图无未解析 import（非零即抛错） */
export function assertNoUnresolvedImports(metafile, allowedExternals = []) {
  const unresolved = findUnresolvedImports(metafile, allowedExternals);
  if (unresolved.length > 0) {
    throw new Error(`[vscode] 产物存在未解析 import：${JSON.stringify(unresolved, null, 2)}`);
  }
  return unresolved;
}
