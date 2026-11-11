import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 部署路径（构建时决定，事后不可通用）。
  //   根目录部署（自有子域名 / GitHub 用户站点）      → 默认 '/'，什么都不用设
  //   子路径部署（GitHub 项目站点 /xxx/）             → VITE_BASE=/SpriteMotion/ npm run build
  // 注意：base 会被写死进 index.html 的资源路径，用子路径构建的产物放到根目录会全部 404。
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE || '/';

  return {
    base,
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    // 让 VITE_* 以及各厂商的 *_API_KEY 都能通过 import.meta.env 读取。
    // 注意：不要用 define 注入 process.env.*，Vite 在 dev 模式下不会替换它，
    // 浏览器里没有 process 对象，会抛 ReferenceError 导致整页白屏。
    envPrefix: ['VITE_', 'GEMINI_', 'OPENAI_'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
