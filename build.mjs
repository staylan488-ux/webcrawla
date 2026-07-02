import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

await esbuild.build({
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    offscreen: 'src/offscreen/offscreen.ts',
    options: 'src/options/options.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  logLevel: 'info',
})

cpSync('src/manifest.json', 'dist/manifest.json')
cpSync('src/offscreen/offscreen.html', 'dist/offscreen.html')
cpSync('src/options/options.html', 'dist/options.html')
