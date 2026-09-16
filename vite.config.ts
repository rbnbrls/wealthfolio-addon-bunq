import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: { entry: 'src/addon.tsx', fileName: () => 'addon.js', formats: ['es'] },
    rollupOptions: {
      external: [
        'react', 'react-dom', 'react-dom/client',
        '@wealthfolio/addon-sdk', '@wealthfolio/ui', '@tanstack/react-query'
      ]
    }
  }
});
