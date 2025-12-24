# Obsidian Note Publisher

ObsidianのMarkdown記事をワンクリックでnote.comに公開するプラグイン。

## 🎉 v1.2.0 新機能

**MCP HTTP API経由での画像挿入**に対応！

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

# ポート3000が使用中の場合は別のポートを指定
# MCP_HTTP_PORT=3001 npm run start:http
```

### 2. Obsidianプラグインのインストール

1. `plugin/` フォルダ内の以下のファイルをコピー：
   - `main.js`
   - `manifest.json`
   - `styles.css`

2. Obsidianの `.obsidian/plugins/obsidian-to-note-publisher/` に配置

3. Obsidianを再起動し、設定からプラグインを有効化

### 3. プラグイン設定

Obsidianの **設定 → Note Publisher** で以下を設定：

| 設定                      | 推奨値                  | 説明                                       |
| ------------------------- | ----------------------- | ------------------------------------------ |
| MCP Server URL            | `http://localhost:3000` | MCPサーバーのURL（ポート変更時は適宜修正） |
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
| `**bold**`       | 太字           | `<strong>`     |
| `*italic*`       | 斜体           | `<em>`         |

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
Cannot connect to MCP server at http://localhost:3000
```

**解決策:**
1. MCPサーバーが起動しているか確認
   ```bash
   curl http://localhost:3000/health
   ```
2. ポート3000が他のアプリで使用中の場合は、ポート3001で起動
   ```bash
   MCP_HTTP_PORT=3001 npm run start:http
   ```
   その場合、プラグイン設定のMCP Server URLも `http://localhost:3001` に変更
3. ファイアウォールの設定を確認

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
node esbuild.config.mjs production
```

### ファイル構成

```
plugin/
├── main.ts       # プラグイン本体
├── main.js       # ビルド済み
├── manifest.json # プラグインメタデータ
├── styles.css    # スタイル
└── esbuild.config.mjs
```

## 📄 ライセンス

MIT

## 🔗 関連リンク

- [note MCP Server](https://github.com/shimayuz/note-com-mcp) - MCPサーバー本体
- [note.com](https://note.com) - 投稿先プラットフォーム
