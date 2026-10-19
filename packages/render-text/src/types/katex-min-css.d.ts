// katex.min.css 的模块声明（md-export Task 2b）：pipeline katex 步动态导入排印
// 样式，vite 构建期抽为独立样式 chunk，运行时无类型面——plain tsc 程序（本包
// tsconfig）据此通过；apps/web 侧由 vite/client 的 *.css 声明覆盖。
declare module 'katex/dist/katex.min.css';
