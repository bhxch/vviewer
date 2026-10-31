import { describe, expect, it } from 'vitest';
import {
  matchIconTheme,
  normalizeIconTheme,
  validateVscodeIconTheme,
  VSCODE_LANG_EXT,
  type NormalizedIconTheme,
} from '../src/vscodeIcon';

/** 校验通过则返回归一化主题，否则炸出 reason（仿 vscode.test.ts 的 r.ok 收窄，集中一处）。 */
function ok(r: ReturnType<typeof validateVscodeIconTheme>): NormalizedIconTheme {
  if (!r.ok) throw new Error(`期望通过校验: ${r.reason}`);
  return r.theme;
}

/** 字形占位：fontCharacter 用私用区真实单字符（\u{e0xx} 各不相同便于断言来源层）。 */
const c = (n: number) => String.fromCodePoint(0xe000 + n);

describe('validateVscodeIconTheme', () => {
  it('① 完整主题：validate ok 且五表/回退键/开关/fonts 归一化正确', () => {
    const t = ok(
      validateVscodeIconTheme({
        name: 'Test Icons',
        iconDefinitions: {
          _file: { fontCharacter: c(1), fontColor: '#a074c4' },
          _folder: { fontCharacter: c(2) },
          _folder_open: { fontCharacter: c(3) },
          _ts: { fontCharacter: c(4), fontColor: '#519aba', fontSize: '16px', fontId: 'testfont' },
          _js: { fontCharacter: c(5) },
          _pn: { fontCharacter: c(6) },
          _src: { fontCharacter: c(7) },
        },
        fonts: [{ id: 'testfont', src: './fonts/test.woff2', format: 'woff2' }],
        fileExtensions: { ts: '_ts', js: '_js' },
        fileNames: { 'package.json': '_pn' },
        languageIds: { typescript: '_ts' },
        folderNames: { src: '_src' },
        folderNamesExpanded: { src: '_src' },
        hidesExplorerArrows: true,
      }),
    );
    expect(t.name).toBe('Test Icons');
    expect(t.fileExtensions.get('ts')).toEqual({ char: c(4), color: '#519aba', fontSize: '16px' });
    expect(t.fileExtensions.get('js')?.char).toBe(c(5));
    expect(t.fileNames.get('package.json')?.char).toBe(c(6));
    expect(t.languageIds.get('typescript')?.char).toBe(c(4));
    expect(t.folderNames.get('src')?.char).toBe(c(7));
    expect(t.folderNamesExpanded.get('src')?.char).toBe(c(7));
    expect(t._file).toEqual({ char: c(1), color: '#a074c4' });
    expect(t._folder?.char).toBe(c(2));
    expect(t._folder_open?.char).toBe(c(3));
    expect(t.hidesExplorerArrows).toBe(true);
    // src 单字符串形态归一化为数组
    expect(t.fonts).toEqual([{ id: 'testfont', src: ['./fonts/test.woff2'], format: 'woff2' }]);
  });

  it('② 缺 iconDefinitions / 形状垃圾 / 定义全坏 → 拒', () => {
    expect(validateVscodeIconTheme({ name: 'x', fonts: [] }).ok).toBe(false);
    expect(validateVscodeIconTheme(null).ok).toBe(false);
    expect(validateVscodeIconTheme('icons').ok).toBe(false);
    expect(validateVscodeIconTheme([]).ok).toBe(false);
    expect(validateVscodeIconTheme(42).ok).toBe(false);
    // 定义存在但逐条被剔（非单字符）→ 过滤后全空才拒（容错口径）
    expect(validateVscodeIconTheme({ iconDefinitions: { bad: { fontCharacter: 'ab' } } }).ok).toBe(false);
  });

  it('③ fontColor 非法色值剔该定义（COLOR_VALUE_RE 同口径），合法定义保留', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          good: { fontCharacter: c(1), fontColor: '#519aba' },
          badStr: { fontCharacter: c(2), fontColor: 'red;}' }, // 含 ;} 的注入值 → 整条剔
          badNum: { fontCharacter: c(3), fontColor: 42 }, // 数字 → 整条剔
          badUrl: { fontCharacter: c(4), fontColor: 'url(https://evil)' }, // 非 hex/rgb 形态 → 整条剔
        },
        fileExtensions: { a: 'good', b: 'badStr', cc: 'badNum', d: 'badUrl' },
      }),
    );
    expect([...t.fileExtensions.keys()]).toEqual(['a']);
    expect(t.fileExtensions.get('a')?.color).toBe('#519aba');
  });

  it('④ fontCharacter 非单字符拒该定义；码点安全（emoji 代理对算单字符）', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          good: { fontCharacter: c(1) },
          emoji: { fontCharacter: '😀' }, // U+1F600 代理对 → [...str].length === 1 → 合法
          multi: { fontCharacter: 'ab' }, // 两字符 → 剔
          escapeText: { fontCharacter: '\\e001' }, // 官方主题的转义文本形态（5 字符）→ 剔
          empty: { fontCharacter: '' }, // 空 → 剔
          num: { fontCharacter: 42 }, // 非 string → 剔
          quote: { fontCharacter: '"' }, // content:"…" 串内可截断 CSS → 注入兜底剔
          backslash: { fontCharacter: '\\' }, // 同上
          ctrl: { fontCharacter: '\n' }, // 控制符 → 剔
        },
        fileExtensions: {
          good: 'good',
          emoji: 'emoji',
          multi: 'multi',
          escapeText: 'escapeText',
          empty: 'empty',
          num: 'num',
          quote: 'quote',
          backslash: 'backslash',
          ctrl: 'ctrl',
        },
      }),
    );
    expect([...t.fileExtensions.keys()].sort()).toEqual(['emoji', 'good']);
  });

  it('⑤ fonts.src 绝对路径/协议前缀拒：逐 src 过滤、全坏剔字体、fontId 悬空连带剔定义', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          a: { fontCharacter: c(1), fontId: 'keep' },
          b: { fontCharacter: c(2), fontId: 'drop' }, // drop 字体全 src 坏 → 悬空 → 连带剔
          d: { fontCharacter: c(3), fontId: 'ghost' }, // 引用从未存在的字体 → 悬空 → 剔
          e: { fontCharacter: c(4) }, // 无 fontId 不受影响
        },
        fonts: [
          { id: 'drop', src: 'http://evil.com/x.woff2' }, // 协议前缀 → 字体剔
          { id: 'data', src: 'data:font/woff2;base64,AAA' }, // data: → 字体剔
          { id: 'keep', src: ['/abs/x.woff', './fonts/ok.woff2'] }, // 混合：剔 /abs 留相对
          { id: 'bad id";x', src: './ok.woff' }, // id 含注入字符（进 font-family）→ 字体剔
          { id: 'fmt', src: './f.woff2', format: 'woff2"};evil' }, // format 注入 → format 剔、字体留
        ],
        fileExtensions: { a: 'a', b: 'b', d: 'd', e: 'e' },
      }),
    );
    expect(t.fonts).toEqual([
      { id: 'keep', src: ['./fonts/ok.woff2'] },
      { id: 'fmt', src: ['./f.woff2'] },
    ]);
    expect([...t.fileExtensions.keys()].sort()).toEqual(['a', 'e']);
  });
});

describe('matchIconTheme', () => {
  it('⑥ 优先级 fileNames > fileExtensions > languageIds（反向表）> _file', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          byName: { fontCharacter: c(1) },
          byExt: { fontCharacter: c(2) },
          byLang: { fontCharacter: c(3) },
          _file: { fontCharacter: c(4) },
        },
        fileNames: { 'a.ts': 'byName' },
        fileExtensions: { ts: 'byExt' },
        languageIds: { javascript: 'byLang' }, // 注意：'ts' 已被 fileExtensions 占位，语言层用 js 证位次
      }),
    );
    expect(matchIconTheme(t, { kind: 'file', name: 'a.ts' })?.char).toBe(c(1)); // 精确名最先
    expect(matchIconTheme(t, { kind: 'file', name: 'b.ts' })?.char).toBe(c(2)); // 后缀次之
    expect(matchIconTheme(t, { kind: 'file', name: 'c.js' })?.char).toBe(c(3)); // 反向表 javascript
    expect(matchIconTheme(t, { kind: 'file', name: 'zzz' })?.char).toBe(c(4)); // 无后缀 → _file 回退
  });

  it('⑦ 多级后缀 .d.ts 全后缀尝试且最长优先', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          dts: { fontCharacter: c(1) },
          ts: { fontCharacter: c(2) },
          _file: { fontCharacter: c(3) },
        },
        fileExtensions: { 'd.ts': 'dts', ts: 'ts' },
      }),
    );
    expect(matchIconTheme(t, { kind: 'file', name: 'foo.d.ts' })?.char).toBe(c(1)); // 'd.ts' 先于 'ts'
    expect(matchIconTheme(t, { kind: 'file', name: 'bar.ts' })?.char).toBe(c(2));
    expect(matchIconTheme(t, { kind: 'file', name: 'x.spec.ts' })?.char).toBe(c(2)); // 'spec.ts' miss → 'ts'
    expect(matchIconTheme(t, { kind: 'file', name: 'lib.d.tsx' })?.char).toBe(c(3)); // 全 miss → _file
  });

  it('⑧ folder/folderExpanded 各自命中，未命中回退 _folder/_folder_open（大小写不敏感）', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          srcDir: { fontCharacter: c(1) },
          srcDirOpen: { fontCharacter: c(2) },
          _folder: { fontCharacter: c(3) },
          _folder_open: { fontCharacter: c(4) },
        },
        folderNames: { src: 'srcDir' },
        folderNamesExpanded: { src: 'srcDirOpen' },
      }),
    );
    expect(matchIconTheme(t, { kind: 'folder', name: 'src' })?.char).toBe(c(1));
    expect(matchIconTheme(t, { kind: 'folderExpanded', name: 'src' })?.char).toBe(c(2));
    expect(matchIconTheme(t, { kind: 'folder', name: 'other' })?.char).toBe(c(3));
    expect(matchIconTheme(t, { kind: 'folderExpanded', name: 'other' })?.char).toBe(c(4));
    expect(matchIconTheme(t, { kind: 'folder', name: 'SRC' })?.char).toBe(c(1)); // 查表大小写不敏感
  });

  it('⑨ languageIds 反向表命中；表外扩展/表外语言静默跳过', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          py: { fontCharacter: c(1) },
          ts: { fontCharacter: c(2) },
          _file: { fontCharacter: c(3) },
        },
        languageIds: { python: 'py', typescript: 'ts', cobol: 'py' }, // cobol 不在反向表
      }),
    );
    expect(matchIconTheme(t, { kind: 'file', name: 'main.py' })?.char).toBe(c(1)); // py→python 命中
    expect(matchIconTheme(t, { kind: 'file', name: 'app.ts' })?.char).toBe(c(2)); // ts→typescript 命中
    expect(matchIconTheme(t, { kind: 'file', name: 'x.mjs' })?.char).toBe(c(3)); // mjs→javascript 未配 → 静默落 _file
    expect(matchIconTheme(t, { kind: 'file', name: 'main.qq' })?.char).toBe(c(3)); // 反向表外扩展：静默
    expect(matchIconTheme(t, { kind: 'file', name: 'a.cbl' })?.char).toBe(c(3)); // 主题配了 cobol 但表无 cbl：静默
  });

  it('⑩ 无 _file 且无任何命中 → null（hidesExplorerArrows 缺省 false）', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: { other: { fontCharacter: c(1) } },
        fileExtensions: { x: 'other' },
      }),
    );
    expect(matchIconTheme(t, { kind: 'file', name: 'nope.zzz' })).toBeNull();
    expect(matchIconTheme(t, { kind: 'file', name: 'nope' })).toBeNull();
    expect(matchIconTheme(t, { kind: 'folder', name: 'nope' })).toBeNull();
    expect(matchIconTheme(t, { kind: 'folderExpanded', name: 'nope' })).toBeNull();
    expect(t.hidesExplorerArrows).toBe(false);
  });

  it('查表大小写不敏感：fileNames/fileExtensions 查前 lowercase（对齐 VSCode）', () => {
    const t = ok(
      validateVscodeIconTheme({
        iconDefinitions: {
          mk: { fontCharacter: c(1) },
          ts: { fontCharacter: c(2) },
        },
        fileNames: { makefile: 'mk' },
        fileExtensions: { ts: 'ts' },
      }),
    );
    expect(matchIconTheme(t, { kind: 'file', name: 'Makefile' })?.char).toBe(c(1));
    expect(matchIconTheme(t, { kind: 'file', name: 'MAKEFILE' })?.char).toBe(c(1));
    expect(matchIconTheme(t, { kind: 'file', name: 'A.TS' })?.char).toBe(c(2));
  });
});

describe('normalizeIconTheme（IndexedDB 记录端重建入口）', () => {
  it('垃圾输入不炸：返回空主题（容错，不抛）', () => {
    const t = normalizeIconTheme('垃圾');
    expect(t.name).toBe('');
    expect(t.fileNames.size).toBe(0);
    expect(t.fileExtensions.size).toBe(0);
    expect(t.languageIds.size).toBe(0);
    expect(t.folderNames.size).toBe(0);
    expect(t.folderNamesExpanded.size).toBe(0);
    expect(t._file).toBeUndefined();
    expect(t._folder).toBeUndefined();
    expect(t._folder_open).toBeUndefined();
    expect(t.hidesExplorerArrows).toBe(false);
    expect(t.fonts).toEqual([]);
  });
  it('hidesExplorerArrows 非 true 一律归 false；与 validate 产形一致', () => {
    const raw = {
      name: 'x',
      hidesExplorerArrows: 'yes',
      iconDefinitions: { _file: { fontCharacter: c(1) } },
    };
    expect(normalizeIconTheme(raw).hidesExplorerArrows).toBe(false);
    expect(normalizeIconTheme({ ...raw, hidesExplorerArrows: true }).hidesExplorerArrows).toBe(true);
  });
});

describe('VSCODE_LANG_EXT（vendored 反向表锚点）', () => {
  it('typescript 不含 tsx（归 typescriptreact）；javascript 含 jsx/mjs/cjs', () => {
    expect(VSCODE_LANG_EXT['typescript']).toEqual(['.ts', '.mts', '.cts']);
    expect(VSCODE_LANG_EXT['typescriptreact']).toEqual(['.tsx']);
    expect(VSCODE_LANG_EXT['javascript']).toEqual(['.js', '.es6', '.jsx', '.mjs', '.cjs']);
    expect(VSCODE_LANG_EXT['javascriptreact']).toEqual(['.jsx']);
    expect(VSCODE_LANG_EXT['python']).toContain('.py');
    expect(VSCODE_LANG_EXT['shellscript']).toContain('.sh');
  });
  it('表自洽：≥40 个主流 id，值非空且元素均以 . 开头', () => {
    const entries = Object.entries(VSCODE_LANG_EXT);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const [id, exts] of entries) {
      expect(id.trim().length, `语言 id ${id} 非空`).toBeGreaterThan(0);
      expect(exts.length, `${id} 扩展非空`).toBeGreaterThan(0);
      for (const ext of exts) expect(ext.startsWith('.'), `${id}: ${ext} 以点开头`).toBe(true);
    }
  });
});
