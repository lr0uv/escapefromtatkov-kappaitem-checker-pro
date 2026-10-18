// 英語版ページ public/en/index.html を作るスクリプト。
// 日本語の public/index.html を元に、data-i18n の付いた文言を英語に置き換えて書き出す。
// デプロイのたびに GitHub Actions で実行するので、翻訳は public/assets/i18n.js だけを直せばよい。
// 手元で試すとき： node tools/build-en.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { T } from '../public/assets/i18n.js';

const src = new URL('../public/index.html', import.meta.url);
const out = new URL('../public/en/index.html', import.meta.url);
const en = T.en;
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const word = (key) => {
  if (!(key in en)) throw new Error(`英語の訳がありません: ${key}`);
  return esc(en[key]);
};

let html = readFileSync(src, 'utf8');
// <タグ data-i18n="key">日本語</タグ> の中身を英語にする（中身が文字だけの要素に限る）
html = html.replace(/(<([a-z0-9]+)\b[^>]*\bdata-i18n="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (_, open, tag, key, text, close) => open + word(key) + close);
// 属性の翻訳（placeholder、aria-label、meta の content）
html = html.replace(/(\bdata-i18n-placeholder="(\w+)"[^>]*?\bplaceholder=")[^"]*"/g, (_, head, key) => `${head}${word(key)}"`);
html = html.replace(/(<[^>]*\bplaceholder=")[^"]*("[^>]*\bdata-i18n-placeholder="(\w+)")/g, (_, head, tail, key) => `${head}${word(key)}${tail}`);
html = html.replace(/(<[^>]*\baria-label=")[^"]*("[^>]*\bdata-i18n-aria="(\w+)")/g, (_, head, tail, key) => `${head}${word(key)}${tail}`);
html = html.replace(/(<meta\b[^>]*\bdata-i18n-content="(\w+)"[^>]*?\bcontent=")[^"]*"/g, (_, head, key) => `${head}${word(key)}"`);
// ページそのものの言語とURL
html = html.replace('<html lang="ja" data-page-lang="ja">', '<html lang="en" data-page-lang="en">');
html = html.replace('<link rel="canonical" href="https://kappacontainer.com/">', '<link rel="canonical" href="https://kappacontainer.com/en/">');
html = html.replace('<meta property="og:url" content="https://kappacontainer.com/">', '<meta property="og:url" content="https://kappacontainer.com/en/">\n  <meta property="og:locale" content="en_US">');
html = html.replace('<!doctype html>', '<!doctype html>\n<!-- このファイルは tools/build-en.mjs が自動で作ります。直接編集しないでください。 -->');

const left = html.match(/data-i18n="(\w+)"[^>]*>[^<]*[぀-ヿ一-鿿]/g);
if (left) throw new Error(`日本語が残っています: ${left.join(', ')}`);
mkdirSync(new URL('../public/en/', import.meta.url), { recursive: true });
writeFileSync(out, html);
console.log('wrote public/en/index.html');
