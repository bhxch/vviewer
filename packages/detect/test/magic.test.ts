import { describe, it, expect } from 'vitest';
import { sniffSignature, looksTextual, shebangLangOf } from '../src/detect/magic';

/** 构造 MPEG-TS 样本：packetSize 处为 0x47 的最小流（0/188/376 三重同步字节） */
function mpegtsHead(bytes: number): Uint8Array {
  const b = new Uint8Array(bytes);
  for (const off of [0, 188, 376]) {
    if (off < bytes) b[off] = 0x47;
  }
  return b;
}

describe('sniffSignature', () => {
  it('zip / ole / png / jpeg / gif / pdf', () => {
    expect(sniffSignature(new Uint8Array([0x50,0x4b,0x03,0x04,1]))).toBe('zip');
    expect(sniffSignature(new Uint8Array([0x50,0x4b,0x05,0x06]))).toBe('zip');
    expect(sniffSignature(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))).toBe('ole');
    expect(sniffSignature(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))).toBe('png');
    expect(sniffSignature(new Uint8Array([0xff,0xd8,0xff,0xe0]))).toBe('jpeg');
    expect(sniffSignature(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(sniffSignature(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
  });
  it('text returns null', () => {
    expect(sniffSignature(new TextEncoder().encode('hello world'))).toBeNull();
  });
  it('mpegts：0/188/376 三重 0x47 同步字节命中（BUG-01）', () => {
    expect(sniffSignature(mpegtsHead(377))).toBe('mpegts');
    expect(sniffSignature(mpegtsHead(1024))).toBe('mpegts');
  });
  it('mpegts：单/双同步字节（head 不足 377B）不命中——TypeScript 文本等短样本安全', () => {
    expect(sniffSignature(mpegtsHead(189))).toBeNull();
    expect(sniffSignature(mpegtsHead(376))).toBeNull();
    // 首字节 0x47（'G'）但无后续包同步：不命中
    expect(sniffSignature(new TextEncoder().encode('G'.repeat(300)))).toBeNull();
  });
});

describe('looksTextual（无扩展名回退链的文本性探测，BUG-07）', () => {
  it('普通文本 / 空 / 常用控制符（\\t\\n\\r\\f）为真', () => {
    expect(looksTextual(new TextEncoder().encode('#!/usr/bin/env python3\nprint(1)\n'))).toBe(true);
    expect(looksTextual(new Uint8Array(0))).toBe(true);
    expect(looksTextual(new TextEncoder().encode('a\tb\nc\rd\x0ce'))).toBe(true);
  });
  it('含 NUL 或控制字符占比超阈值判二进制', () => {
    expect(looksTextual(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    const noisy = new Uint8Array(100).fill(0x41);
    for (let i = 0; i < 10; i++) noisy[i] = 0x01; // 10% 可疑控制字符 > 5% 阈值
    expect(looksTextual(noisy)).toBe(false);
  });
  it('非严格 UTF-8（gb18030 候选）不据此拒绝', () => {
    // 0xD0 0xD1 是合法 gb18030 双字节序列首字节，非严格 UTF-8
    expect(looksTextual(new Uint8Array([0xd0, 0xd1, 0x61, 0x62]))).toBe(true);
  });
});

describe('shebangLangOf（无扩展名 shebang 语言，BUG-07 输出契约）', () => {
  it('常见解释器 → helix 语言键', () => {
    expect(shebangLangOf('#!/usr/bin/env python3\nprint("x")\n')).toBe('python');
    expect(shebangLangOf('#!/bin/bash\nset -e\n')).toBe('bash');
    expect(shebangLangOf('#!/usr/bin/node\nconsole.log(1)\n')).toBe('javascript');
    expect(shebangLangOf('#!/usr/bin/env ruby\nputs 1\n')).toBe('ruby');
    expect(shebangLangOf('#!/usr/bin/perl -w\n')).toBe('perl');
    expect(shebangLangOf('#! /bin/sh\n')).toBe('bash');
  });
  it('非 shebang / 未知解释器 / 空文本返回 null', () => {
    expect(shebangLangOf('plain text\n')).toBeNull();
    expect(shebangLangOf('#!/usr/bin/definitely-not-a-lang\n')).toBeNull();
    expect(shebangLangOf('')).toBeNull();
  });
});
