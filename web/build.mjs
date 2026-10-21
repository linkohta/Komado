// src/main.ts を 1 本の IIFE（komado.js）にまとめる。
// 使い方: node build.mjs [--outdir=<出力先>]   （省略時は dist/）
// Gradle（app/build.gradle.kts の bundle*WebScripts）からは生成アセットのディレクトリを渡して呼ばれる。
import { build } from 'esbuild';
import { join } from 'node:path';

const outdirArg = process.argv.find((a) => a.startsWith('--outdir='));
const outdir = outdirArg ? outdirArg.slice('--outdir='.length) : 'dist';

await build({
  entryPoints: ['src/main.ts'],
  outfile: join(outdir, 'komado.js'),
  bundle: true,
  format: 'iife',
  // DOCUMENT_START_SCRIPT と WebMessageListener が使える WebView はこれより新しい
  target: 'chrome87',
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: '/* Komado: web/src から生成されたファイル。直接編集しない */' },
  logLevel: 'warning',
});
