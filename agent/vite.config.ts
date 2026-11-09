import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// Builds the agent CLI into one self-contained file (dist/agent.mjs) with every dependency
// (mqtt, systeminformation) inlined, so it runs with just `node dist/agent.mjs` - no npm install.
// Only Node's built-in modules stay external. The target machine needs Node.js >= 20.12.
export default defineConfig({
  build: {
    ssr: 'src/cli.ts',
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, /^node:/],
      output: {
        format: 'es',
        entryFileNames: 'agent.mjs',
        codeSplitting: false,
        // Some bundled CommonJS dependencies call require(); give them one in the ES module output.
        banner: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)"
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
