/**
 * Client-half bundle: lib/client.js, a single CJS script that registers its
 * factory with the DSH web shell's module table:
 *
 *   window.__ModuleLoader__.load({ id: <package name>, factory: (require) => exports })
 *
 * Contract notes (verified against dsh client-modules sources and the
 * dsh-better-sidebar 0.24.1 artifact):
 * - the registration id MUST equal the npm package name (boot graph entry id
 *   == package name; a mismatched id throws in the module table),
 * - the factory body only registers; module side effects run at first
 *   materialization, so everything lives inside the factory closure,
 * - `clean` stays off — the host-half build (tsdown.config.ts) owns lib/ and
 *   this build must not wipe lib/index.js or lib/client/*.d.ts.
 *
 * This bundle has zero runtime imports (the plugin consumes cordis services
 * through `ctx` only; host-package imports are type-only and erased), so the
 * externals list is belt-and-braces: anything that ever does creep in must be
 * a module-table word (the official PLATFORM_MODULES baseline).
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = '@huanlin/dsh-plugin-sidebar-terminal-tools'

/** The web shell's frozen module-table baseline (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  external: PLATFORM_MODULES,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    codeSplitting: false,
  },
}

export default defineConfig([clientConfig])
