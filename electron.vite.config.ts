import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The agent core runs in its own utility process so the main process
          // (which is also Chromium's browser UI thread) stays idle.
          core: resolve('src/core/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [solid()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
