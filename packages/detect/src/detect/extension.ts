/** 从文件名/URL 提取小写扩展名；无扩展名（含点文件）返回 '' */
export function extractExtension(name: string): string {
  const clean = name.split(/[?#]/, 1)[0] ?? name;
  const base = clean.split('/').pop() ?? clean;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // <=0 覆盖无点与 .dotfile
  return base.slice(dot + 1).toLowerCase();
}
