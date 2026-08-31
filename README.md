# Obsidian Note Publisher

ObsidianのMarkdown記事をワンクリックでnote.comに公開するプラグイン。

## 🎉 v1.2.15 変更点

**Markdownの書式が反映されない問題を修正**

v1.2.14でMarkdown→HTML変換をnoteMCPサーバー側へ一本化しましたが、
サーバー側の変換はnoteMCPのバージョンと `build/` の再ビルド状況に依存します。
変換に対応していない（または古いbuildの）サーバーに当たると、note.comへ
Markdownがそのまま送信され、**太字・コードブロック・箇条書き・見出しなどの
書式が一切反映されない**症状が発生していました。

v1.2.15ではプラグイン側でHTMLへ変換してから送信する方式に戻し、
noteMCPサーバーのバージョンに依存せず書式が反映されるようにしました。

- 設定に **Markdown変換** を追加（既定: `このプラグインで変換`）
- 送信時に `bodyFormat` を渡し、サーバー側での二重変換を抑止
  （v1.2.13で発生していた「タイトル直後に空行が入る」症状は再発しません）
- `**太字**` / `*斜体*` / `~~取り消し線~~` / `==ハイライト==` / `` `コード` `` /
  コードブロック / 箇条書き / 番号付きリスト / 引用 / 水平線 / リンク に対応
- 画像参照は素のまま残し、noteMCPサーバーが `<figure>` へ置換（余計な空行が入りません）

### 書式が反映されない場合

Obsidianの **設定 → Note Publisher → Markdown変換** が
`このプラグインで変換（推奨）` になっているか確認してください。
`noteMCPサーバーに任せる` を選ぶ場合は、noteMCPサーバーを最新版に更新し、
**必ず `npm run build` で再ビルド**してから起動してください。

### v1.2.x の変更点

**noteMCPの構造変更に対応** - デフォルト接続先を `http://127.0.0.1:3000` に変更

- noteMCPのHTTPサーバーが `localhost` ではなく `127.0.0.1` を要求するようになったため対応
- 設定画面の説明を更新

### v1.2.0 で追加された機能

- MCP HTTP API経由での画像挿入
- CLIやPlaywright不要 - 純粋なHTTP API通信
- 画像をnote.comのS3に直接アップロード
- アイキャッチ（サムネイル）の自動設定
- Markdown→HTML自動変換

## 🎯 概要

このプラグインは [note MCP Server](https://github.com/shimayuz/note-com-mcp) と連携して動作します。

```
Obsidian → Note Publisher Plugin → MCP Server → note.com API
```

## 📦 インストール

### 前提条件

- [note MCP Server](https://github.com/shimayuz/note-com-mcp) が起動していること
- note.comアカウントとセッション情報が設定済みであること

### 1. note MCP Serverのセットアップ

```bash
# note MCPをクローン
git clone https://github.com/shimayuz/note-com-mcp.git
cd note-com-mcp

# 依存関係をインストール
npm install

# ビルド
npm run build

# HTTPサーバーを起動（デフォルト: ポート3000）
npm run start:http
```

### 2. Obsidianプラグインのインストール

#### 方法A: BRAT（推奨）

[BRAT (Obsidian42 - BRAT)](https://github.com/TfTHacker/obsidian42-brat) はGitHubリポジトリから
ベータ版プラグインを直接インストール・自動更新できるコミュニティプラグインです。

1. Obsidianの **設定 → コミュニティプラグイン** から **BRAT** をインストールして有効化
2. コマンドパレット（Cmd/Ctrl+P）で **「BRAT: Add a beta plugin for testing」** を実行
3. 次のリポジトリパスを入力：
   ```
   shimayuz/obsidian-to-note-publisher
   ```
4. **Add Plugin** をクリック（最新リリースが自動でインストールされます）
5. **設定 → コミュニティプラグイン** から「Note Publisher」を有効化

**更新するとき:**
コマンドパレットで **「BRAT: Check for updates to all beta plugins」** を実行するか、
BRATの設定で「Auto-enable plugins after installing」「Auto-update at startup」を有効にしておきます。

> ⚠️ BRATはリポジトリ**ルートの `manifest.json`** からバージョンを読み取り、
> そのバージョンの**GitHubリリース**に添付された `main.js` / `manifest.json` / `styles.css`
> をダウンロードします。`plugin/` 配下のファイルは参照されません。
> リリースの作り方は「開発者向け → リリース手順」を参照してください。

#### 方法B: 手動インストール（BRATを使わない場合）

1. [Releases](https://github.com/shimayuz/obsidian-to-note-publisher/releases) から最新版の
   `main.js` / `manifest.json` / `styles.css` をダウンロード
2. Obsidianのプラグインフォルダに新規フォルダを作成し、3ファイルを配置：
   ```
   [Vaultフォルダ]/.obsidian/plugins/obsidian-to-note-publisher/
   ```

   **配置例:**
   ```
   MyVault/
   └── .obsidian/
       └── plugins/
           └── obsidian-to-note-publisher/
               ├── main.js
               ├── manifest.json
               └── styles.css
   ```

3. Obsidianを再起動
4. **設定 → コミュニティプラグイン** から「Note Publisher」を有効化

### 3. プラグイン設定

Obsidianの **設定 → Note Publisher** で以下を設定：

| 設定                      | 推奨値                  | 説明                                       |
| ------------------------- | ----------------------- | ------------------------------------------ |
| MCP Server URL            | `http://127.0.0.1:3000` | MCPサーバーのURL（localhostではなくIPアドレスを指定） |
| Markdown変換              | `このプラグインで変換`   | 書式（太字・コードブロック等）をHTMLに変換してから送信 |
| API Mode                  | ✅ ON                    | v1.2.0推奨（画像をAPI経由で挿入）          |
| Open Editor After Publish | ✅ ON                    | 公開後にnote.comエディタを開く             |
| Show Notification         | ✅ ON                    | 完了通知を表示                             |

## 🚀 使い方

1. 公開したいMarkdownファイルを開く
2. コマンドパレット（Cmd/Ctrl+P）で **「Publish to note.com」** を選択
3. 確認モーダルで内容を確認し、**「Publish as Draft」** をクリック
4. 自動でnote.comに下書きが保存される

### クイック公開

確認モーダルをスキップしたい場合：
- コマンドパレットで **「Publish to note.com (Quick)」** を選択

## 📄 対応形式

### Frontmatter

```yaml
---
title: 記事タイトル
tags:
  - タグ1
  - タグ2
eyecatch: path/to/thumbnail.png
---
```

| フィールド | 説明                                     |
| ---------- | ---------------------------------------- |
| `title`    | 記事タイトル（省略時はH1または最初の行） |
| `tags`     | タグ（最大10個）                         |
| `eyecatch` | アイキャッチ画像のパス                   |

### 画像形式

| 形式             | 例                          |
| ---------------- | --------------------------- |
| Obsidian形式     | `![[image.png]]`            |
| キャプション付き | `![[image.png\|説明文]]`    |
| 標準Markdown     | `![alt](path/to/image.png)` |

### Markdown→note.com変換ルール

| Markdown         | note.com       | HTML           |
| ---------------- | -------------- | -------------- |
| `#` (H1)         | 大見出し       | `<h2>`         |
| `##` (H2)        | 大見出し       | `<h2>`         |
| `###` (H3)       | 小見出し       | `<h3>`         |
| `####`〜 (H4-H6) | 太字           | `<strong>`     |
| `- item`         | 箇条書き       | `<ul><li>`     |
| `1. item`        | 番号付きリスト | `<ol><li>`     |
| ` ```code``` `   | コードブロック | `<pre><code>`  |
| `> quote`        | 引用           | `<blockquote>` |
| `---`            | 区切り線       | `<hr>`         |
| `**bold**`       | 太字           | `<strong>`     |
| `*italic*`       | 斜体           | `<em>`         |
| `~~del~~`        | 取り消し線     | `<del>`        |
| `==mark==`       | 太字           | `<strong>`     |
| `` `code` ``     | インラインコード | `<code>`     |
| `[text](url)`    | リンク         | `<a>`          |

## 📝 サンプル記事

```markdown
---
title: 【入門】Obsidianからnoteへ自動投稿する方法
tags:
  - Obsidian
  - note
  - 自動化
eyecatch: images/thumbnail.png
---

## はじめに

この記事では、Obsidianで書いた記事をワンクリックでnote.comに投稿する方法を解説します。

![[images/screenshot.png]]

### 必要なもの

- Obsidian
- note MCPサーバー
- Note Publisherプラグイン

## セットアップ手順

1. note MCPをインストール
2. プラグインを有効化
3. 設定を完了

![[images/settings.png|設定画面]]

## まとめ

これで簡単に記事を公開できるようになりました！
```

## 🛠️ トラブルシューティング

### MCPサーバーに接続できない

```
Cannot connect to MCP server at http://127.0.0.1:3000
```

**解決策:**
1. MCPサーバーが起動しているか確認
   ```bash
   curl http://127.0.0.1:3000/health
   ```
2. プラグイン設定のMCP Server URLが `http://127.0.0.1:3000` になっているか確認
   - `localhost` ではなく `127.0.0.1` を使用してください（noteMCPの仕様変更）
3. ファイアウォールの設定を確認

### 太字・コードブロック・箇条書きが反映されない

note.comの記事で `**太字**` や ``` ```bash ``` がそのままの文字列で表示される場合、
本文がHTMLに変換されずMarkdownのまま送信されています。

**解決策:**
1. プラグインをv1.2.15以降に更新する
2. **設定 → Note Publisher → Markdown変換** を `このプラグインで変換（推奨）` にする
3. `noteMCPサーバーに任せる` を使いたい場合は、noteMCPサーバー側を更新して再ビルドする
   ```bash
   cd note-com-mcp
   git pull
   npm install
   npm run build      # ← build/ を再生成しないと変更が反映されません
   npm run start:http
   ```
4. Obsidianの開発者コンソール（Cmd/Ctrl+Shift+I）で
   `[Note Publisher] Conversion mode: plugin (bodyFormat=html)` が出ているか確認する

### 画像がアップロードされない

**解決策:**
1. 画像ファイルが存在するか確認
2. 画像パスが正しいか確認（Markdownファイルからの相対パス）
3. MCPサーバーのログを確認

### アイキャッチが設定されない

**解決策:**
1. frontmatterの`eyecatch`フィールドを確認
2. 画像ファイルが存在するか確認
3. API Modeが有効になっているか確認

### 認証エラー

```
Authentication failed
```

**解決策:**
1. MCPサーバーの`.env`ファイルに認証情報が設定されているか確認
2. note.comのセッションが有効か確認
3. MCPサーバーを再起動

## ⚙️ 開発者向け

### ビルド

```bash
cd plugin
npm install
npm run build          # tsc -noEmit で型チェック → esbuildでmain.jsを生成
```

### リリース手順（BRAT配信）

BRATは**リポジトリルートの `manifest.json` のバージョン**を見て、
`https://github.com/shimayuz/obsidian-to-note-publisher/releases/download/<version>/main.js`
を取得します。**GitHubリリースに資産を添付しないとBRAT経由では更新が届きません。**

1. バージョンを3ファイルすべてで揃える
   - `manifest.json`（ルート・BRATが読む）
   - `plugin/manifest.json`
   - `package.json`
   > 既存のタグと重複しないバージョンにしてください（`git tag -l` で確認）
2. `cd plugin && npm run build` で `plugin/main.js` を再生成してコミット
3. タグを打って push
   ```bash
   git tag 1.2.15
   git push origin 1.2.15
   ```
4. `.github/workflows/release.yml` が自動でビルドし、
   `main.js` / `manifest.json` / `styles.css` を添付したリリースを作成します

手動でリリースする場合も、必ずこの3ファイルを**リリースの添付ファイル**として
アップロードしてください（リポジトリに置くだけではBRATは取得しません）。

### リポジトリ構成

```
obsidian-to-note-publisher/
├── README.md              # このファイル
├── package.json           # プロジェクト設定
├── .env.example           # 環境変数サンプル
├── bin/
│   └── obsidian-to-note   # CLIツール
├── src/
│   └── publisher.js       # パブリッシャー本体
├── scripts/
│   └── setup.js           # セットアップスクリプト
└── plugin/                # Obsidianプラグイン
    ├── main.ts            # プラグインソースコード
    ├── main.js            # ビルド済みプラグイン
    ├── manifest.json      # プラグインメタデータ
    ├── styles.css         # スタイル
    ├── package.json       # プラグイン依存関係
    ├── tsconfig.json      # TypeScript設定
    └── esbuild.config.mjs # ビルド設定
```

**インストールに必要なファイル（`plugin/`内）:**
- `main.js` - プラグイン本体
- `manifest.json` - プラグイン情報
- `styles.css` - UI スタイル

## 📄 ライセンス

MIT

## 🔗 関連リンク

- [note MCP Server](https://github.com/shimayuz/note-com-mcp) - MCPサーバー本体
- [note.com](https://note.com) - 投稿先プラットフォーム
