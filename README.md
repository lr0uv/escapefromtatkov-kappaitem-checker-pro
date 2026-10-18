# Kappaチェッカー（kappacontainer.com）

Escape from Tarkov のKappaコンテナ（Fenceのタスク「Collector」）で納品するアイテムを、アカウント登録なしでチェックできるWebアプリです。

- **アイテム一覧は自動で最新になります。** tarkov.dev のAPIから取得して、サーバーに数時間保存して使い回します。パッチでアイテムが増えても、手作業での追加は不要です。
- **進捗は PvP／PvE／シーズン で別々に記録します。**
- **個人情報は持ちません。** 進捗はまずブラウザに保存します。別の端末と同期したいときだけ「合言葉」を発行します。合言葉はQRコードやリンクで別の端末に渡せます。
- 閲覧専用の共有リンク、ファイルへのバックアップ、日本語／英語の切り替えに対応しています。

## 仕組み

```text
ブラウザ（index.html + assets/app.js）
  ├─ api/items.php  … tarkov.dev から Collector のアイテムとアイコンURLを取得（6時間キャッシュ）
  ├─ api/sync.php   … 合言葉で進捗を同期（サーバーには合言葉そのものではなくハッシュだけを保存）
  └─ api/share.php  … 閲覧専用リンクの進捗を返す
サーバー上の api/_data/ … SQLiteのデータベースとキャッシュ（外から見えないよう .htaccess で保護）
```

- 動作に必要なもの：PHP 8.1以上（PDO SQLite拡張が有効なこと）、Apache（.htaccess が効くこと）
- 外部サービスのアカウントは不要です。ランニングコストはレンタルサーバー代とドメイン代だけです。

## フォルダ構成

| パス | 役割 |
|---|---|
| `public/` | サーバーにアップロードする中身すべて |
| `public/assets/app.js` | 画面の動き（チェック、同期、共有など） |
| `public/assets/style.css` | 見た目 |
| `public/assets/vendor/qrcode.js` | QRコード生成ライブラリ（qrcode-generator 1.4.4, MIT） |
| `public/api/*.php` | サーバー側の処理 |
| `.github/workflows/deploy.yml` | main に反映されたら FTP で自動アップロード（設定したときだけ動く） |
| `docs/DEPLOY.md` | 公開手順（初心者向け） |

## 手元で動かす（Mac）

```bash
cd public
php -S 127.0.0.1:8000
```

ブラウザで http://127.0.0.1:8000 を開きます。macOS には PHP が入っていないので、先に `brew install php` でインストールしてください。

公開手順は [docs/DEPLOY.md](docs/DEPLOY.md) を見てください。

---

データ提供: [tarkov.dev](https://tarkov.dev/) ／ Escape from Tarkov is a trademark of Battlestate Games. 本サイトは非公式のファンツールです。
