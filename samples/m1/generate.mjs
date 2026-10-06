// 生成 M1 冒烟样例所需的二进制文件（pixel.png 为 1x1 像素，70B 可入库）
import { writeFileSync } from 'node:fs';

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
writeFileSync(new URL('./pixel.png', import.meta.url), png1x1);
