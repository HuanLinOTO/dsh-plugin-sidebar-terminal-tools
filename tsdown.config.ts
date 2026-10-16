/**
 * Host-half bundle: lib/index.js (+ lib/index.d.ts via tsdown dts).
 * Mirrors dsh-sleep's config; the three peers stay external because the
 * DSH host supplies them at runtime.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = '@huanlin/dsh-plugin-sidebar-terminal-tools'

const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
]

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: { neverBundle: HOST_EXTERNALS },
}

export default defineConfig([libConfig])
