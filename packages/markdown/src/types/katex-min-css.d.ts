// katex.min.css 的模块声明（md-export Task 2b）：pipeline katex 步动态导入排印
// 样式，vite 构建期抽为独立样式 chunk，运行时无类型面——plain tsc 程序据此通过；
// vite 形态另有 vite/client 的 *.css 声明覆盖，双形态并存无冲突。
// 引入方式：pipeline.ts 顶部 /// <reference path> 指令——ambient declare module
// 不随 import 图传播（pack-packages 回注机制同一结论），指令随 pipeline 源进入
// 每个编译单元（跨包源码消费无需各持副本）。本文件保持 script 形态（无 export），
// 供指令按路径收进；发布态由 pack copies 复制到 dist/types/ 并回注 index.d.ts。
declare module 'katex/dist/katex.min.css';
