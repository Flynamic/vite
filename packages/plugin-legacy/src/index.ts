/* eslint-disable node/no-extraneous-import */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, normalizePath } from 'vite'
import MagicString from 'magic-string'
import type {
  BuildOptions,
  HtmlTagDescriptor,
  Plugin,
  ResolvedConfig
} from 'vite'
import type {
  NormalizedOutputOptions,
  OutputBundle,
  OutputOptions,
  PreRenderedChunk,
  RenderedChunk
} from 'rollup'
import type { PluginItem as BabelPlugin } from '@babel/core'
import colors from 'picocolors'
import type { Options } from './types'

// lazy load babel since it's not used during dev
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let babel: typeof import('@babel/standalone') | undefined
async function loadBabel() {
  if (!babel) {
    babel = await import('@babel/standalone')
  }
  return babel
}

// Duplicated from build.ts in Vite Core, at least while the feature is experimental
// We should later expose this helper for other plugins to use
function toOutputFilePathInHtml(
  filename: string,
  type: 'asset' | 'public',
  hostId: string,
  hostType: 'js' | 'css' | 'html',
  config: ResolvedConfig,
  toRelative: (filename: string, importer: string) => string
): string {
  const { renderBuiltUrl } = config.experimental
  let relative = config.base === '' || config.base === './'
  if (renderBuiltUrl) {
    const result = renderBuiltUrl(filename, {
      hostId,
      hostType,
      type,
      ssr: !!config.build.ssr
    })
    if (typeof result === 'object') {
      if (result.runtime) {
        throw new Error(
          `{ runtime: "${result.runtime}" } is not supported for assets in ${hostType} files: ${filename}`
        )
      }
      if (typeof result.relative === 'boolean') {
        relative = result.relative
      }
    } else if (result) {
      return result
    }
  }
  if (relative && !config.build.ssr) {
    return toRelative(filename, hostId)
  } else {
    return config.base + filename
  }
}
function getBaseInHTML(urlRelativePath: string, config: ResolvedConfig) {
  // Prefer explicit URL if defined for linking to assets and public files from HTML,
  // even when base relative is specified
  return config.base === './' || config.base === ''
    ? path.posix.join(
        path.posix.relative(urlRelativePath, '').slice(0, -2),
        './'
      )
    : config.base
}

function toAssetPathFromHtml(
  filename: string,
  htmlPath: string,
  config: ResolvedConfig
): string {
  const relativeUrlPath = normalizePath(path.relative(config.root, htmlPath))
  const toRelative = (filename: string, hostId: string) =>
    getBaseInHTML(relativeUrlPath, config) + filename
  return toOutputFilePathInHtml(
    filename,
    'asset',
    htmlPath,
    'html',
    config,
    toRelative
  )
}

// https://gist.github.com/samthor/64b114e4a4f539915a95b91ffd340acc
// DO NOT ALTER THIS CONTENT
const safari10NoModuleFix = `!function(){var e=document,t=e.createElement("script");if(!("noModule"in t)&&"onbeforeload"in t){var n=!1;e.addEventListener("beforeload",(function(e){if(e.target===t)n=!0;else if(!e.target.hasAttribute("nomodule")||!n)return;e.preventDefault()}),!0),t.type="module",t.src=".",e.head.appendChild(t),t.remove()}}();`

const legacyPolyfillId = 'vite-legacy-polyfill'
const legacyEntryId = 'vite-legacy-entry'
const systemJSInlineCode = `System.import(document.getElementById('${legacyEntryId}').getAttribute('data-src'))`

const detectModernBrowserVarName = '__vite_is_modern_browser'
const detectModernBrowserCode = `try{import.meta.url;import("_").catch(()=>1);}catch(e){}window.${detectModernBrowserVarName}=true;`
const dynamicFallbackInlineCode = `!function(){if(window.${detectModernBrowserVarName})return;console.warn("vite: loading legacy build because dynamic import or import.meta.url is unsupported, syntax error above should be ignored");var e=document.getElementById("${legacyPolyfillId}"),n=document.createElement("script");n.src=e.src,n.onload=function(){${systemJSInlineCode}},document.body.appendChild(n)}();`

const forceDynamicImportUsage = `export function __vite_legacy_guard(){import('data:text/javascript,')};`

const legacyEnvVarMarker = `__VITE_IS_LEGACY__`

const _require = createRequire(import.meta.url)

function viteLegacyPlugin(options: Options = {}): Plugin[] {
  let config: ResolvedConfig
  const targets = options.targets || 'defaults'
  const genLegacy = options.renderLegacyChunks !== false
  const genDynamicFallback = genLegacy

  const debugFlags = (process.env.DEBUG || '').split(',')
  const isDebug =
    debugFlags.includes('vite:*') || debugFlags.includes('vite:legacy')

  const facadeToLegacyChunkMap = new Map()
  const facadeToLegacyPolyfillMap = new Map()
  const facadeToModernPolyfillMap = new Map()
  const modernPolyfills = new Set<string>()
  const legacyPolyfills = new Set<string>()

  if (Array.isArray(options.modernPolyfills)) {
    options.modernPolyfills.forEach((i) => {
      modernPolyfills.add(
        i.includes('/') ? `core-js/${i}` : `core-js/modules/${i}.js`
      )
    })
  }
  if (Array.isArray(options.polyfills)) {
    options.polyfills.forEach((i) => {
      if (i.startsWith(`regenerator`)) {
        legacyPolyfills.add(`regenerator-runtime/runtime.js`)
      } else {
        legacyPolyfills.add(
          i.includes('/') ? `core-js/${i}` : `core-js/modules/${i}.js`
        )
      }
    })
  }
  if (Array.isArray(options.additionalLegacyPolyfills)) {
    options.additionalLegacyPolyfills.forEach((i) => {
      legacyPolyfills.add(i)
    })
  }

  let overriddenBuildTarget = false
  const legacyConfigPlugin: Plugin = {
    name: 'vite:legacy-config',

    config(config, env) {
      if (env.command === 'build') {
        if (!config.build) {
          config.build = {}
        }

        if (!config.build.cssTarget) {
          // Hint for esbuild that we are targeting legacy browsers when minifying CSS.
          // Full CSS compat table available at https://github.com/evanw/esbuild/blob/78e04680228cf989bdd7d471e02bbc2c8d345dc9/internal/compat/css_table.go
          // But note that only the `HexRGBA` feature affects the minify outcome.
          // HSL & rebeccapurple values will be minified away regardless the target.
          // So targeting `chrome61` suffices to fix the compatibility issue.
          config.build.cssTarget = 'chrome61'
        }

        if (genLegacy) {
          // Vite's default target browsers are **not** the same.
          // See https://github.com/vitejs/vite/pull/10052#issuecomment-1242076461
          overriddenBuildTarget = config.build.target !== undefined
          // browsers supporting ESM + dynamic import + import.meta
          config.build.target = [
            'es2020',
            'edge79',
            'firefox67',
            'chrome64',
            'safari11.1'
          ]
        }
      }

      return {
        define: {
          'import.meta.env.LEGACY':
            env.command === 'serve' || config.build?.ssr
              ? false
              : legacyEnvVarMarker
        }
      }
    },
    configResolved(config) {
      if (overriddenBuildTarget) {
        config.logger.warn(
          colors.yellow(
            `plugin-legacy overrode 'build.target'. You should pass 'targets' as an option to this plugin with the list of legacy browsers to support instead.`
          )
        )
      }
    }
  }

  const legacyGenerateBundlePlugin: Plugin = {
    name: 'vite:legacy-generate-polyfill-chunk',
    apply: 'build',

    async generateBundle(opts, bundle) {
      if (config.build.ssr) {
        return
      }

      if (!isLegacyBundle(bundle, opts)) {
        if (!modernPolyfills.size) {
          return
        }
        isDebug &&
          console.log(
            `[@vitejs/plugin-legacy] modern polyfills:`,
            modernPolyfills
          )
        await buildPolyfillChunk(
          config.mode,
          modernPolyfills,
          bundle,
          facadeToModernPolyfillMap,
          config.build,
          'es',
          opts,
          true
        )
        return
      }

      if (!genLegacy) {
        return
      }

      // legacy bundle
      if (legacyPolyfills.size || genDynamicFallback) {
        // check if the target needs Promise polyfill because SystemJS relies on it
        // https://github.com/systemjs/systemjs#ie11-support
        await detectPolyfills(
          `Promise.resolve(); Promise.all();`,
          targets,
          legacyPolyfills
        )

        isDebug &&
          console.log(
            `[@vitejs/plugin-legacy] legacy polyfills:`,
            legacyPolyfills
          )

        await buildPolyfillChunk(
          config.mode,
          legacyPolyfills,
          bundle,
          facadeToLegacyPolyfillMap,
          // force using terser for legacy polyfill minification, since esbuild
          // isn't legacy-safe
          config.build,
          'iife',
          opts,
          options.externalSystemJS
        )
      }
    }
  }

  const legacyPostPlugin: Plugin = {
    name: 'vite:legacy-post-process',
    enforce: 'post',
    apply: 'build',

    configResolved(_config) {
      if (_config.build.lib) {
        throw new Error('@vitejs/plugin-legacy does not support library mode.')
      }
      config = _config

      if (!genLegacy || config.build.ssr) {
        return
      }

      const getLegacyOutputFileName = (
        fileNames:
          | string
          | ((chunkInfo: PreRenderedChunk) => string)
          | undefined,
        defaultFileName = '[name]-legacy.[hash].js'
      ): string | ((chunkInfo: PreRenderedChunk) => string) => {
        if (!fileNames) {
          return path.posix.join(config.build.assetsDir, defaultFileName)
        }

        return (chunkInfo) => {
          let fileName =
            typeof fileNames === 'function' ? fileNames(chunkInfo) : fileNames

          if (fileName.includes('[name]')) {
            // [name]-[hash].[format] -> [name]-legacy-[hash].[format]
            fileName = fileName.replace('[name]', '[name]-legacy')
          } else {
            // entry.js -> entry-legacy.js
            fileName = fileName.replace(/(.+)\.(.+)/, '$1-legacy.$2')
          }

          return fileName
        }
      }

      const createLegacyOutput = (
        options: OutputOptions = {}
      ): OutputOptions => {
        return {
          ...options,
          format: 'system',
          entryFileNames: getLegacyOutputFileName(options.entryFileNames),
          chunkFileNames: getLegacyOutputFileName(options.chunkFileNames)
        }
      }

      const { rollupOptions } = config.build
      const { output } = rollupOptions
      if (Array.isArray(output)) {
        rollupOptions.output = [...output.map(createLegacyOutput), ...output]
      } else {
        rollupOptions.output = [createLegacyOutput(output), output || {}]
      }
    },

    async renderChunk(raw, chunk, opts) {
      if (config.build.ssr) {
        return null
      }

      if (!isLegacyChunk(chunk, opts)) {
        if (
          options.modernPolyfills &&
          !Array.isArray(options.modernPolyfills)
        ) {
          // analyze and record modern polyfills
          await detectPolyfills(raw, { esmodules: true }, modernPolyfills)
        }

        const ms = new MagicString(raw)

        if (genDynamicFallback && chunk.isEntry) {
          ms.prepend(forceDynamicImportUsage)
        }

        if (raw.includes(legacyEnvVarMarker)) {
          const re = new RegExp(legacyEnvVarMarker, 'g')
          let match
          while ((match = re.exec(raw))) {
            ms.overwrite(
              match.index,
              match.index + legacyEnvVarMarker.length,
              `false`
            )
          }
        }

        if (config.build.sourcemap) {
          return {
            code: ms.toString(),
            map: ms.generateMap({ hires: true })
          }
        }
        return {
          code: ms.toString()
        }
      }

      if (!genLegacy) {
        return null
      }

      // @ts-ignore avoid esbuild transform on legacy chunks since it produces
      // legacy-unsafe code - e.g. rewriting object properties into shorthands
      opts.__vite_skip_esbuild__ = true

      // @ts-ignore force terser for legacy chunks. This only takes effect if
      // minification isn't disabled, because that leaves out the terser plugin
      // entirely.
      opts.__vite_force_terser__ = true

      // @ts-ignore
      // In the `generateBundle` hook,
      // we'll delete the assets from the legacy bundle to avoid emitting duplicate assets.
      // But that's still a waste of computing resource.
      // So we add this flag to avoid emitting the asset in the first place whenever possible.
      opts.__vite_skip_asset_emit__ = true

      // @ts-ignore avoid emitting assets for legacy bundle
      const needPolyfills =
        options.polyfills !== false && !Array.isArray(options.polyfills)

      // transform the legacy chunk with @babel/preset-env
      const sourceMaps = !!config.build.sourcemap
      const babel = await loadBabel()
      const { code, map } = babel.transform(raw, {
        babelrc: false,
        configFile: false,
        compact: !!config.build.minify,
        sourceMaps,
        inputSourceMap: undefined, // sourceMaps ? chunk.map : undefined, `.map` TODO: moved to OutputChunk?
        presets: [
          // forcing our plugin to run before preset-env by wrapping it in a
          // preset so we can catch the injected import statements...
          [
            () => ({
              plugins: [
                recordAndRemovePolyfillBabelPlugin(legacyPolyfills),
                replaceLegacyEnvBabelPlugin(),
                wrapIIFEBabelPlugin()
              ]
            })
          ],
          [
            'env',
            createBabelPresetEnvOptions(targets, {
              needPolyfills,
              ignoreBrowserslistConfig: options.ignoreBrowserslistConfig
            })
          ]
        ]
      })

      if (code) return { code, map }
      return null
    },

    transformIndexHtml(html, { chunk }) {
      if (config.build.ssr) return
      if (!chunk) return
      if (chunk.fileName.includes('-legacy')) {
        // The legacy bundle is built first, and its index.html isn't actually
        // emitted. Here we simply record its corresponding legacy chunk.
        facadeToLegacyChunkMap.set(chunk.facadeModuleId, chunk.fileName)
        return
      }

      const tags: HtmlTagDescriptor[] = []
      const htmlFilename = chunk.facadeModuleId?.replace(/\?.*$/, '')

      // 1. inject modern polyfills
      const modernPolyfillFilename = facadeToModernPolyfillMap.get(
        chunk.facadeModuleId
      )

      if (modernPolyfillFilename) {
        tags.push({
          tag: 'script',
          attrs: {
            type: 'module',
            crossorigin: true,
            src: toAssetPathFromHtml(
              modernPolyfillFilename,
              chunk.facadeModuleId!,
              config
            )
          }
        })
      } else if (modernPolyfills.size) {
        throw new Error(
          `No corresponding modern polyfill chunk found for ${htmlFilename}`
        )
      }

      if (!genLegacy) {
        return { html, tags }
      }

      // 2. inject Safari 10 nomodule fix
      tags.push({
        tag: 'script',
        attrs: { nomodule: true },
        children: safari10NoModuleFix,
        injectTo: 'body'
      })

      // 3. inject legacy polyfills
      const legacyPolyfillFilename = facadeToLegacyPolyfillMap.get(
        chunk.facadeModuleId
      )
      if (legacyPolyfillFilename) {
        tags.push({
          tag: 'script',
          attrs: {
            nomodule: true,
            crossorigin: true,
            id: legacyPolyfillId,
            src: toAssetPathFromHtml(
              legacyPolyfillFilename,
              chunk.facadeModuleId!,
              config
            )
          },
          injectTo: 'body'
        })
      } else if (legacyPolyfills.size) {
        throw new Error(
          `No corresponding legacy polyfill chunk found for ${htmlFilename}`
        )
      }

      // 4. inject legacy entry
      const legacyEntryFilename = facadeToLegacyChunkMap.get(
        chunk.facadeModuleId
      )
      if (legacyEntryFilename) {
        // `assets/foo.js` means importing "named register" in SystemJS
        tags.push({
          tag: 'script',
          attrs: {
            nomodule: true,
            crossorigin: true,
            // we set the entry path on the element as an attribute so that the
            // script content will stay consistent - which allows using a constant
            // hash value for CSP.
            id: legacyEntryId,
            'data-src': toAssetPathFromHtml(
              legacyEntryFilename,
              chunk.facadeModuleId!,
              config
            )
          },
          children: systemJSInlineCode,
          injectTo: 'body'
        })
      } else {
        throw new Error(
          `No corresponding legacy entry chunk found for ${htmlFilename}`
        )
      }

      // 5. inject dynamic import fallback entry
      if (genDynamicFallback && legacyPolyfillFilename && legacyEntryFilename) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: detectModernBrowserCode,
          injectTo: 'head'
        })
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: dynamicFallbackInlineCode,
          injectTo: 'head'
        })
      }

      return {
        html,
        tags
      }
    },

    generateBundle(opts, bundle) {
      if (config.build.ssr) {
        return
      }

      if (isLegacyBundle(bundle, opts)) {
        // avoid emitting duplicate assets
        for (const name in bundle) {
          if (bundle[name].type === 'asset') {
            delete bundle[name]
          }
        }
      }
    }
  }

  return [legacyConfigPlugin, legacyGenerateBundlePlugin, legacyPostPlugin]
}

export async function detectPolyfills(
  code: string,
  targets: any,
  list: Set<string>
): Promise<void> {
  const babel = await loadBabel()
  const { ast } = babel.transform(code, {
    ast: true,
    babelrc: false,
    configFile: false,
    presets: [
      [
        'env',
        createBabelPresetEnvOptions(targets, { ignoreBrowserslistConfig: true })
      ]
    ]
  })
  for (const node of ast!.program.body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value
      if (
        source.startsWith('core-js/') ||
        source.startsWith('regenerator-runtime/')
      ) {
        list.add(source)
      }
    }
  }
}

function createBabelPresetEnvOptions(
  targets: any,
  {
    needPolyfills = true,
    ignoreBrowserslistConfig
  }: { needPolyfills?: boolean; ignoreBrowserslistConfig?: boolean }
) {
  return {
    targets,
    bugfixes: true,
    loose: false,
    modules: false,
    useBuiltIns: needPolyfills ? 'usage' : false,
    corejs: needPolyfills
      ? {
          version: _require('core-js/package.json').version,
          proposals: false
        }
      : undefined,
    shippedProposals: true,
    ignoreBrowserslistConfig
  }
}

async function buildPolyfillChunk(
  mode: string,
  imports: Set<string>,
  bundle: OutputBundle,
  facadeToChunkMap: Map<string, string>,
  buildOptions: BuildOptions,
  format: 'iife' | 'es',
  rollupOutputOptions: NormalizedOutputOptions,
  excludeSystemJS?: boolean
) {
  let { minify, assetsDir } = buildOptions
  minify = minify ? 'terser' : false
  const res = await build({
    mode,
    // so that everything is resolved from here
    root: path.dirname(fileURLToPath(import.meta.url)),
    configFile: false,
    logLevel: 'error',
    plugins: [polyfillsPlugin(imports, excludeSystemJS)],
    build: {
      write: false,
      minify,
      assetsDir,
      rollupOptions: {
        input: {
          polyfills: polyfillId
        },
        output: {
          format,
          entryFileNames: rollupOutputOptions.entryFileNames
        }
      }
    },
    // Don't run esbuild for transpilation or minification
    // because we don't want to transpile code.
    esbuild: false,
    optimizeDeps: {
      esbuildOptions: {
        // If a value above 'es5' is set, esbuild injects helper functions which uses es2015 features.
        // This limits the input code not to include es2015+ codes.
        // But core-js is the only dependency which includes commonjs code
        // and core-js doesn't include es2015+ codes.
        target: 'es5'
      }
    }
  })
  const _polyfillChunk = Array.isArray(res) ? res[0] : res
  if (!('output' in _polyfillChunk)) return
  const polyfillChunk = _polyfillChunk.output[0]

  // associate the polyfill chunk to every entry chunk so that we can retrieve
  // the polyfill filename in index html transform
  for (const key in bundle) {
    const chunk = bundle[key]
    if (chunk.type === 'chunk' && chunk.facadeModuleId) {
      facadeToChunkMap.set(chunk.facadeModuleId, polyfillChunk.fileName)
    }
  }

  // add the chunk to the bundle
  bundle[polyfillChunk.fileName] = polyfillChunk
}

const polyfillId = '\0vite/legacy-polyfills'

function polyfillsPlugin(
  imports: Set<string>,
  excludeSystemJS?: boolean
): Plugin {
  return {
    name: 'vite:legacy-polyfills',
    resolveId(id) {
      if (id === polyfillId) {
        return id
      }
    },
    load(id) {
      if (id === polyfillId) {
        return (
          [...imports].map((i) => `import ${JSON.stringify(i)};`).join('') +
          (excludeSystemJS ? '' : `import "systemjs/dist/s.min.js";`)
        )
      }
    }
  }
}

function isLegacyChunk(chunk: RenderedChunk, options: NormalizedOutputOptions) {
  return options.format === 'system' && chunk.fileName.includes('-legacy')
}

function isLegacyBundle(
  bundle: OutputBundle,
  options: NormalizedOutputOptions
) {
  if (options.format === 'system') {
    const entryChunk = Object.values(bundle).find(
      (output) => output.type === 'chunk' && output.isEntry
    )

    return !!entryChunk && entryChunk.fileName.includes('-legacy')
  }

  return false
}

function recordAndRemovePolyfillBabelPlugin(
  polyfills: Set<string>
): BabelPlugin {
  return ({ types: t }): BabelPlugin => ({
    name: 'vite-remove-polyfill-import',
    post({ path }) {
      path.get('body').forEach((p) => {
        if (t.isImportDeclaration(p)) {
          // @ts-expect-error
          polyfills.add(p.node.source.value)
          p.remove()
        }
      })
    }
  })
}

function replaceLegacyEnvBabelPlugin(): BabelPlugin {
  return ({ types: t }): BabelPlugin => ({
    name: 'vite-replace-env-legacy',
    visitor: {
      Identifier(path) {
        if (path.node.name === legacyEnvVarMarker) {
          path.replaceWith(t.booleanLiteral(true))
        }
      }
    }
  })
}

function wrapIIFEBabelPlugin(): BabelPlugin {
  return ({ types: t, template }): BabelPlugin => {
    const buildIIFE = template(';(function(){%%body%%})();')

    return {
      name: 'vite-wrap-iife',
      post({ path }) {
        if (!this.isWrapped) {
          this.isWrapped = true
          path.replaceWith(t.program(buildIIFE({ body: path.node.body })))
        }
      }
    }
  }
}

export const cspHashes = [
  createHash('sha256').update(safari10NoModuleFix).digest('base64'),
  createHash('sha256').update(systemJSInlineCode).digest('base64'),
  createHash('sha256').update(detectModernBrowserCode).digest('base64'),
  createHash('sha256').update(dynamicFallbackInlineCode).digest('base64')
]

export default viteLegacyPlugin
