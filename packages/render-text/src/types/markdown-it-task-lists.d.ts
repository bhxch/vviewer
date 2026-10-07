// markdown-it-task-lists 2.x 无自带类型；仅用其默认导出作为 markdown-it 插件。
declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}
