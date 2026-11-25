import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

const bridgePort = process.env.OFFICE_PORT || 3110;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: '@import "@/styles/tokens.scss";\n'
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: false
      }
    }
  }
});
