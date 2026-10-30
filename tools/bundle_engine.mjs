import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['pg_entry.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  external: ['node:*'],
  define: { 'import.meta.url': JSON.stringify('http://localhost/plugin/') },
  outfile: 'ui/vendor/pglite-bundle.js',
  logLevel: 'warning',
})

console.log('bundled -> ui/vendor/pglite-bundle.js')
