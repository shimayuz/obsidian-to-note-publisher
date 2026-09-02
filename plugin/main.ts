import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import * as path from 'path';

// ========================================
// Types
// ========================================

/**
 * 本文のMarkdown→HTML変換をどこで行うか。
 * - 'plugin': プラグイン側で変換してHTMLを送信する（既定・推奨）。
 *             noteMCPサーバーのバージョンに依存せず書式が反映される。
 * - 'server': Markdownのまま送信し、noteMCPサーバーの変換に任せる。
 *             サーバーがMarkdown変換に対応していない/古いbuildの場合、
 *             書式が一切反映されないので注意。
 */
type ConversionMode = 'plugin' | 'server';

interface NotePublisherSettings {
    mcpServerUrl: string;
    headlessMode: boolean;
    openEditorAfterPublish: boolean;
    showNotification: boolean;
    defaultTags: string[];
    useApiMode: boolean;  // v1.2.0: API経由での画像挿入
    conversionMode: ConversionMode;  // v1.2.15: Markdown→HTML変換の実行場所
}

const DEFAULT_SETTINGS: NotePublisherSettings = {
    mcpServerUrl: 'http://127.0.0.1:3000',
    headlessMode: true,
    openEditorAfterPublish: true,
    showNotification: true,
    defaultTags: [],
    useApiMode: true,  // v1.2.0: デフォルトでAPI経由
    conversionMode: 'plugin'  // v1.2.15: 既定はプラグイン側で変換（サーバー非依存）
};

interface ImageInfo {
    fileName: string;
    localPath: string;
    exists: boolean;
    base64?: string;
    mimeType?: string;
}

interface ParsedMarkdown {
    title: string;
    body: string;
    tags: string[];
    images: ImageInfo[];
    eyecatch?: ImageInfo;
}

/** noteMCPへ渡す本文の形式。'html' を渡すとサーバー側のMarkdown変換がスキップされる */
type BodyFormat = 'markdown' | 'html';

interface PublishResult {
    success: boolean;
    message?: string;
    title?: string;
    noteUrl?: string;
    imageCount?: number;
    images?: string[];
    tags?: string[];
    error?: string;
}

// ========================================
// Frontmatter Utilities
// ========================================

/**
 * ファイル先頭のfrontmatterブロック（--- ... ---）の位置と中身の行を返す。
 * frontmatterが無ければnull。
 */
interface FrontmatterBlock {
    /** 閉じフェンス行の改行までを含む、frontmatterブロック全体の終端インデックス */
    endIndex: number;
    /** フェンスに挟まれた中身の行 */
    lines: string[];
}

function parseFrontmatterBlock(content: string): FrontmatterBlock | null {
    // frontmatterはファイル先頭の --- 行から始まるものだけを対象にする
    const opening = content.match(/^---[ \t]*\r?\n/);
    if (!opening) return null;

    const innerStart = opening[0].length;
    const rest = content.slice(innerStart);

    // 閉じフェンス（行頭の --- または ...）
    const closing = rest.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
    if (!closing || closing.index === undefined) return null;

    const innerText = rest.slice(0, closing.index);
    const endIndex = innerStart + closing.index + closing[0].length;
    const lines = innerText === ''
        ? []
        : innerText.replace(/\r?\n$/, '').split(/\r?\n/);

    return { endIndex, lines };
}

/**
 * トップレベルのキー行なら、そのキー名を返す。
 * インデントされた行・リスト項目（- ...）・コメント行はキー行ではない。
 */
function topLevelKeyOf(line: string): string | null {
    const match = line.match(/^([A-Za-z0-9_][A-Za-z0-9_\-. ]*?)[ \t]*:(?:[ \t].*)?$/);
    return match ? match[1] : null;
}

/**
 * 直前のキーに属する継続行かどうか。
 * インデント行・リスト項目・空行が該当する（リストやブロックスカラーの中身）。
 */
function isContinuationLine(line: string): boolean {
    if (line.trim() === '') return true;
    if (/^[ \t]/.test(line)) return true;
    if (/^-(?:[ \t]|$)/.test(line)) return true;
    return false;
}

/** YAMLのプレーンスカラーとして書けない値かどうか */
function needsYamlQuoting(value: string): boolean {
    if (value === '') return true;
    if (value !== value.trim()) return true;              // 前後に空白がある
    if (/[\r\n\t]/.test(value)) return true;              // 改行・タブを含む
    if (value.includes(':')) return true;                 // key: value と誤読されうる
    if (/^[-?,[\]{}#&*!|>'"%@`]/.test(value)) return true; // YAMLの指示文字で始まる
    if (/\s#/.test(value)) return true;                   // 行内コメントに見える
    if (/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)) return true;  // 真偽値・null
    if (/^[+-]?\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(value)) return true;  // 数値に見える
    if (/^0[bxo]/i.test(value)) return true;              // 2進・16進・8進に見える
    return false;
}

/** 値をYAMLのスカラー表記にする */
function toYamlScalar(value: any): string {
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(v => toYamlScalar(v)).join(', ')}]`;
    }
    const text = String(value);
    if (!needsYamlQuoting(text)) return text;
    const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}

/**
 * frontmatterの行配列に更新を適用する。
 *
 * 更新対象のキーの行（およびそのリスト・ブロックスカラーの継続行）だけを差し替え、
 * それ以外の行は一切触らない。以前は「全体をパースして作り直す」実装だったため、
 * 投稿のたびに以下が壊れていた:
 *   - tags / aliases などのリストが丸ごと消える（`tags: ""` になる）
 *   - `description: |` などのブロックスカラーの中身が消え、YAMLとして不正になる
 *   - frontmatter内のコメント行が消える
 *   - クォート付きの値からクォートが外れる（`"[[link]]"` → `[[link]]`）
 *   - ネストしたキーがトップレベルへ引き上げられる
 */
function applyFrontmatterUpdates(lines: string[], updates: Record<string, any>): string[] {
    const result = lines.slice();

    for (const [key, value] of Object.entries(updates)) {
        // 対象キーの行と、それに属する継続行の範囲を探す
        let keyIndex = -1;
        for (let i = 0; i < result.length; i++) {
            if (topLevelKeyOf(result[i]) === key) {
                keyIndex = i;
                break;
            }
        }

        if (keyIndex === -1) {
            // 未定義のキー: 削除指示なら何もせず、それ以外は末尾に追加
            if (value !== null && value !== undefined) {
                result.push(`${key}: ${toYamlScalar(value)}`);
            }
            continue;
        }

        let blockEnd = keyIndex + 1;
        while (blockEnd < result.length && isContinuationLine(result[blockEnd])) {
            blockEnd++;
        }
        // 末尾の空行はこのキーのブロックに含めない
        while (blockEnd > keyIndex + 1 && result[blockEnd - 1].trim() === '') {
            blockEnd--;
        }

        if (value === null || value === undefined) {
            result.splice(keyIndex, blockEnd - keyIndex);
        } else {
            result.splice(keyIndex, blockEnd - keyIndex, `${key}: ${toYamlScalar(value)}`);
        }
    }

    return result;
}

/**
 * frontmatterを更新する
 * @param app Obsidian App
 * @param file 対象ファイル
 * @param updates 更新するフィールド（値がnull/undefinedのキーは削除）
 */
async function updateFrontmatter(app: App, file: TFile, updates: Record<string, any>): Promise<void> {
    const content = await app.vault.read(file);
    const block = parseFrontmatterBlock(content);

    let newContent: string;

    if (block) {
        const newLines = applyFrontmatterUpdates(block.lines, updates);
        const newFrontmatter = `---\n${newLines.join('\n')}\n---\n`;
        // replace()の置換文字列では $& などが特殊扱いされるため、slice で連結する
        newContent = newFrontmatter + content.slice(block.endIndex);
    } else {
        // frontmatterがない場合は新規作成
        const newLines: string[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (value !== null && value !== undefined) {
                newLines.push(`${key}: ${toYamlScalar(value)}`);
            }
        }
        if (newLines.length === 0) return;
        newContent = `---\n${newLines.join('\n')}\n---\n\n` + content;
    }

    if (newContent === content) return;
    await app.vault.modify(file, newContent);
}

/**
 * 今日の日付をYYYY-MM-DD形式で取得
 */
function getTodayDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * frontmatterからpublish_dateを取得
 */
function getPublishDateFromCache(cache: any): string | undefined {
    return cache?.frontmatter?.publish_date;
}

// ========================================
// MCP Client
// ========================================

class MCPClient {
    private serverUrl: string;
    private requestId: number = 0;

    constructor(serverUrl: string) {
        this.serverUrl = serverUrl.replace(/\/$/, '');
    }

    setServerUrl(url: string) {
        this.serverUrl = url.replace(/\/$/, '');
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.serverUrl}/health`,
                method: 'GET'
            });
            return response.status === 200;
        } catch (e) {
            return false;
        }
    }

    async callTool(toolName: string, args: any): Promise<any> {
        this.requestId++;
        const requestBody = {
            jsonrpc: '2.0',
            id: this.requestId,
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: args
            }
        };

        const bodyStr = JSON.stringify(requestBody);
        console.log(`[Note Publisher] Calling tool: ${toolName}`);
        console.log(`[Note Publisher] URL: ${this.serverUrl}/mcp`);
        console.log(`[Note Publisher] Body size: ${bodyStr.length} bytes`);

        try {
            const response = await requestUrl({
                url: `${this.serverUrl}/mcp`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: bodyStr,
                throw: false
            });

            console.log(`[Note Publisher] Response status: ${response.status}`);
            console.log(`[Note Publisher] Response text: ${response.text.substring(0, 300)}`);

            if (response.status !== 200) {
                throw new Error(`HTTP error: ${response.status} - ${response.text}`);
            }

            const mcpResponse = JSON.parse(response.text);
            if (mcpResponse.error) {
                throw new Error(mcpResponse.error.message);
            }

            if (mcpResponse.result?.content?.[0]?.text) {
                return JSON.parse(mcpResponse.result.content[0].text);
            }
            return mcpResponse.result;
        } catch (e: any) {
            console.error(`[Note Publisher] Request failed:`, e);
            throw e;
        }
    }

    /**
     * v1.2.0: API経由で画像付き下書きを作成
     */
    async publishWithImages(params: {
        title: string;
        markdown: string;
        tags?: string[];
        images?: { fileName: string; base64: string; mimeType?: string }[];
        eyecatch?: { fileName: string; base64: string; mimeType?: string };
        bodyFormat?: BodyFormat;
    }): Promise<PublishResult> {
        try {
            console.log(`[Note Publisher] Using post-draft-note-with-images (API mode)`);

            // bodyFormat: 'html' を渡すと対応サーバーはMarkdown再変換をスキップする。
            // 未対応のサーバーでは未知のキーとして無視されるだけなので安全。
            const toolArgs: any = {
                title: params.title,
                body: params.markdown,
                bodyFormat: params.bodyFormat || 'markdown',
                tags: params.tags || []
            };

            // 画像を追加
            if (params.images && params.images.length > 0) {
                toolArgs.images = params.images;
                console.log(`[Note Publisher] Images: ${params.images.length}`);
            }

            // アイキャッチを追加
            if (params.eyecatch && params.eyecatch.base64) {
                toolArgs.eyecatch = params.eyecatch;
                console.log(`[Note Publisher] Eyecatch: ${params.eyecatch.fileName}`);
            }

            const result = await this.callTool('post-draft-note-with-images', toolArgs);

            if (result.success || result.noteId) {
                return {
                    success: true,
                    message: '下書きを作成しました',
                    title: params.title,
                    noteUrl: result.editUrl || result.noteUrl,
                    imageCount: result.imageCount || 0,
                    images: result.uploadedImages?.map((i: any) => i.name) || [],
                    tags: params.tags || []
                };
            } else {
                return {
                    success: false,
                    error: result.error || result.message || 'Unknown error'
                };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Unknown error'
            };
        }
    }

    /**
     * 従来のpost-draft-note（画像なし、またはアイキャッチのみ）
     */
    async publishFromObsidianRemote(params: {
        title: string;
        markdown: string;
        tags?: string[];
        headless?: boolean;
        saveAsDraft?: boolean;
        eyecatch?: { fileName: string; base64: string; mimeType?: string };
        bodyFormat?: BodyFormat;
    }): Promise<PublishResult> {
        const hasEyecatch = params.eyecatch && params.eyecatch.base64;
        try {
            console.log(`[Note Publisher] Using post-draft-note (eyecatch: ${hasEyecatch ? 'yes' : 'no'})`);

            const toolArgs: any = {
                title: params.title,
                body: params.markdown,
                bodyFormat: params.bodyFormat || 'markdown',
                tags: params.tags
            };

            if (hasEyecatch) {
                toolArgs.eyecatch = params.eyecatch;
            }

            const result = await this.callTool('post-draft-note', toolArgs);

            if (result.success || result.noteId) {
                return {
                    success: true,
                    message: '下書きを作成しました',
                    title: params.title,
                    noteUrl: result.editUrl || result.noteUrl,
                    imageCount: hasEyecatch ? 1 : 0,
                    images: hasEyecatch ? [params.eyecatch!.fileName] : [],
                    tags: params.tags || []
                };
            } else {
                return {
                    success: false,
                    error: result.error || result.message || 'Unknown error'
                };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Unknown error'
            };
        }
    }
}

// ========================================
// Markdown Parser
// ========================================

async function parseMarkdownFile(app: App, file: TFile, conversionMode: ConversionMode): Promise<ParsedMarkdown> {
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);

    const title = extractTitle(content, file, cache);
    const tags = extractTags(cache);
    const fileDir = file.parent?.path || '';
    const eyecatch = await extractEyecatch(app, cache, fileDir);
    const body = prepareBody(content, conversionMode);
    const images = await extractImages(app, content, file);

    return {
        title,
        body,
        tags,
        images,
        eyecatch
    };
}

function extractTitle(content: string, file: TFile, cache: any): string {
    const frontmatter = cache?.frontmatter;
    if (frontmatter?.title) {
        return String(frontmatter.title);
    }
    // frontmatter内のコメント行（# メモ）をH1と誤認しないよう、本文から探す
    const block = parseFrontmatterBlock(content);
    const body = block ? content.slice(block.endIndex) : content;
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    return file.basename;
}

function extractTags(cache: any): string[] {
    const frontmatter = cache?.frontmatter;
    if (!frontmatter?.tags) return [];

    if (Array.isArray(frontmatter.tags)) {
        return frontmatter.tags.map((t: any) => String(t).replace(/^#/, ''));
    }
    if (typeof frontmatter.tags === 'string') {
        return frontmatter.tags.split(',').map((t: string) => t.trim().replace(/^#/, ''));
    }
    return [];
}

async function extractEyecatch(app: App, cache: any, fileDir: string): Promise<ImageInfo | undefined> {
    const frontmatter = cache?.frontmatter;
    if (!frontmatter?.eyecatch) return undefined;

    const eyecatchPath = String(frontmatter.eyecatch);
    console.log(`[Note Publisher] Eyecatch path from frontmatter: ${eyecatchPath}`);

    const imageInfo = await resolveAndEncodeImage(app, eyecatchPath, fileDir);
    if (imageInfo && imageInfo.exists) {
        console.log(`[Note Publisher] Eyecatch image found: ${imageInfo.localPath}`);
        return imageInfo;
    } else {
        console.log(`[Note Publisher] Eyecatch image NOT found: ${eyecatchPath}`);
        return undefined;
    }
}

// ========================================
// Markdown → note.com HTML Converter
// ========================================
//
// v1.2.15: Markdown→HTML変換をプラグイン側で行う（既定）。
//
// v1.2.14でこの変換をnoteMCPサーバーへ一本化したが、サーバー側の変換は
// noteMCPのバージョンとbuild/の再ビルド状況に依存する。変換を持たない
// （または古いbuildの）サーバーに当たると、note.comへMarkdownがそのまま
// 送信され、太字・コードブロック・箇条書きなどの書式が一切反映されない。
// プラグインが自前で変換すればサーバーのバージョンに依存しなくなる。
//
// 二重変換（v1.2.13の「タイトル直後に空行が入る」症状）は次の2点で回避する:
//   1. ツール引数に bodyFormat: 'html' を渡す（対応サーバーは変換をスキップ）
//   2. 生成HTMLが必ずブロック要素で始まるようにする
//      （サーバーのlooksLikeHtml()判定でMarkdown再変換がスキップされる）

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * note.comが各ブロック要素に持たせているname/id属性（UUID）を付与する。
 * br / hr / img と自己終端タグは対象外。
 */
function addUUIDAttributes(html: string): string {
    return html.replace(/<(\w+)([^>]*)>/g, (match, tag: string, attrs: string) => {
        if (tag === 'hr' || tag === 'br' || tag === 'img' || attrs.includes('/')) {
            return match;
        }
        const uuid = generateUUID();
        return `<${tag}${attrs} name="${uuid}" id="${uuid}">`;
    });
}

/**
 * インライン記法を変換する。
 * 画像参照とコードは呼び出し前にプレースホルダーへ退避済みである前提。
 */
function processInline(text: string): string {
    let result = text;

    // Obsidianハイライト (==text==) → 太字
    result = result.replace(/==(.+?)==/g, '<strong>$1</strong>');
    // 太字 (**text**)
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 斜体 (*text*) ※太字の後に処理する
    result = result.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // 取り消し線 (~~text~~)
    result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // リンク [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Obsidian内部リンク [[link|display]] / [[link]]
    result = result.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    result = result.replace(/\[\[([^\]]+)\]\]/g, '$1');

    return result;
}

/** 行が特殊要素（見出し・リスト・引用・水平線・プレースホルダー）かどうか */
function isSpecialLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#{1,6}\s+/.test(trimmed)) return true;
    if (/^[-*]\s+/.test(trimmed)) return true;
    if (/^\d+\.\s+/.test(trimmed)) return true;
    if (/^>/.test(trimmed)) return true;
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) return true;
    if (/^__(?:CODE_BLOCK|IMAGE)_\d+__$/.test(trimmed)) return true;
    return false;
}

/**
 * Markdownをnote.com用のHTMLへ変換する。
 *
 * 変換ルール（READMEの「Markdown→note.com変換ルール」と対応）:
 *   `#` / `##`   → <h2>（大見出し）
 *   `###`        → <h3>（小見出し）
 *   `####`〜     → <p><strong>（太字）
 *   `- item`     → <ul><li>
 *   `1. item`    → <ol><li>
 *   ```code```   → <pre><code>
 *   `> quote`    → <blockquote>
 *   `---`        → <hr>
 *   **bold** → <strong> / *italic* → <em> / ~~del~~ → <del> / ==mark== → <strong>
 *   `code`       → <code>
 *   段落内の単一改行 → <br>（Obsidian準拠）、空行 → 段落区切り
 *
 * 画像参照（![[img.png]] / ![alt](img.png)）はnoteMCPサーバーが<figure>へ
 * 置換するため、変換せず素のまま残す。<p>で包むと<p><figure></p>となり
 * 空の<p>が残って画像の前後に余計な改行が入るため、単独行の画像は包まない。
 */
function convertMarkdownToNoteHtml(markdown: string): string {
    if (!markdown) return '';

    let text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 1. コードブロックを退避（以降の変換から保護）
    const codeBlocks: string[] = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code: string) => {
        const index = codeBlocks.length;
        codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
        return `__CODE_BLOCK_${index}__`;
    });

    // 2. インラインコードを退避
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
        const index = inlineCodes.length;
        inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
        return `__INLINE_CODE_${index}__`;
    });

    // 3. 画像参照を退避（サーバーの<figure>置換用に原文のまま復元する）
    const imageRefs: string[] = [];
    const stashImage = (match: string) => {
        const index = imageRefs.length;
        imageRefs.push(match);
        return `__IMAGE_${index}__`;
    };
    text = text.replace(/!\[\[[^\]]+\]\]/g, stashImage);
    text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, stashImage);

    // 4. 複数行にまたがる太字（**の開始と終了が別の行にあるObsidianの改行スタイル）を先に変換
    text = text.replace(/\*\*((?:(?!\n\n)(?!\*\*)[\s\S])+?)\*\*/g, '<strong>$1</strong>');

    const result: string[] = [];

    for (const paragraph of text.split(/\n\n+/)) {
        const trimmedPara = paragraph.trim();
        if (!trimmedPara) continue;

        const lines = trimmedPara.split('\n');

        // 特殊要素を含まない段落：段落内の単一改行は<br>で保持（Obsidian準拠）
        if (!lines.some(isSpecialLine)) {
            const processed = lines.map(l => processInline(l.trim())).filter(l => l);
            if (processed.length > 0) {
                result.push(`<p>${processed.join('<br>')}</p>`);
            }
            continue;
        }

        // 特殊要素を含む段落は行単位で処理する
        const state: { list: 'ul' | 'ol' | null; items: string[]; quote: string[] } = {
            list: null,
            items: [],
            quote: []
        };

        const closeList = () => {
            if (state.list && state.items.length > 0) {
                const tag = state.list;
                result.push(`<${tag}>${state.items.map(i => `<li>${i}</li>`).join('')}</${tag}>`);
            }
            state.list = null;
            state.items = [];
        };
        const closeQuote = () => {
            if (state.quote.length > 0) {
                result.push(`<blockquote>${state.quote.join('<br>')}</blockquote>`);
                state.quote = [];
            }
        };
        const closeAll = () => { closeList(); closeQuote(); };

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            // コードブロック
            if (/^__CODE_BLOCK_\d+__$/.test(trimmedLine)) {
                closeAll();
                const index = parseInt(trimmedLine.replace(/\D+/g, ''), 10);
                result.push(codeBlocks[index]);
                continue;
            }

            // 単独行の画像参照は<p>で包まず素のまま出力する
            if (/^__IMAGE_\d+__$/.test(trimmedLine)) {
                closeAll();
                result.push(trimmedLine);
                continue;
            }

            // 見出し（# / ## → h2、### → h3、#### 以降 → 太字）
            const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                closeAll();
                const level = headingMatch[1].length;
                const content = processInline(headingMatch[2]);
                if (level <= 2) {
                    result.push(`<h2>${content}</h2>`);
                } else if (level === 3) {
                    result.push(`<h3>${content}</h3>`);
                } else {
                    result.push(`<p><strong>${content}</strong></p>`);
                }
                continue;
            }

            // 水平線
            if (/^-{3,}$/.test(trimmedLine) || /^\*{3,}$/.test(trimmedLine)) {
                closeAll();
                result.push('<hr>');
                continue;
            }

            // 引用（"> text" / ">text" 両対応）
            const quoteMatch = trimmedLine.match(/^>\s?(.*)$/);
            if (quoteMatch) {
                closeList();
                state.quote.push(processInline(quoteMatch[1]));
                continue;
            }
            closeQuote();

            // 箇条書き
            const ulMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
            if (ulMatch) {
                if (state.list === 'ol') closeList();
                state.list = 'ul';
                state.items.push(processInline(ulMatch[1]));
                continue;
            }

            // 番号付きリスト
            const olMatch = trimmedLine.match(/^\d+\.\s+(.+)$/);
            if (olMatch) {
                if (state.list === 'ul') closeList();
                state.list = 'ol';
                state.items.push(processInline(olMatch[1]));
                continue;
            }

            // リスト以外の通常テキスト行
            closeList();
            result.push(`<p>${processInline(trimmedLine)}</p>`);
        }

        closeAll();
    }

    // 連続するblockquoteをマージ（引用の間に余計な改行が入るのを防ぐ）
    const merged: string[] = [];
    for (const item of result) {
        const prev = merged[merged.length - 1];
        if (prev && prev.startsWith('<blockquote>') && prev.endsWith('</blockquote>') &&
            item.startsWith('<blockquote>') && item.endsWith('</blockquote>')) {
            const prevContent = prev.slice('<blockquote>'.length, -'</blockquote>'.length);
            const curContent = item.slice('<blockquote>'.length, -'</blockquote>'.length);
            merged[merged.length - 1] = `<blockquote>${prevContent}<br>${curContent}</blockquote>`;
        } else {
            merged.push(item);
        }
    }

    let html = merged.join('');

    // コードを復元してからUUIDを付与（<pre>/<code>/<a>にもnote.com同様の属性が付く）
    inlineCodes.forEach((code, index) => {
        html = html.split(`__INLINE_CODE_${index}__`).join(code);
    });
    codeBlocks.forEach((code, index) => {
        html = html.split(`__CODE_BLOCK_${index}__`).join(code);
    });

    html = addUUIDAttributes(html);

    // 画像参照は最後に原文のまま復元する（HTMLタグではないのでUUID付与の対象外）
    imageRefs.forEach((ref, index) => {
        html = html.split(`__IMAGE_${index}__`).join(ref);
    });

    return html.trim();
}

function prepareBody(content: string, conversionMode: ConversionMode): string {
    // frontmatterを除去（updateFrontmatterと同じパーサを使う）
    const block = parseFrontmatterBlock(content);
    let body = block ? content.slice(block.endIndex) : content;
    // 先頭のH1タイトル行を除去（タイトルはfrontmatterまたはこの行からextractTitleで取得済み）
    body = body.replace(/^#\s+.+\n*/, '');
    body = body.trim();

    if (conversionMode === 'server') {
        // サーバー側（noteMCPのconvertMarkdownToNoteHtml）に変換を任せる
        return body;
    }

    return convertMarkdownToNoteHtml(body);
}

async function extractImages(app: App, content: string, file: TFile): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    const fileDir = file.parent?.path || '';

    // Obsidian形式: ![[image.png]] or ![[image.png|alt]]
    const obsidianRegex = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = obsidianRegex.exec(content)) !== null) {
        const fileName = match[1].trim();
        const imageInfo = await resolveAndEncodeImage(app, fileName, fileDir);
        if (imageInfo) {
            images.push(imageInfo);
        }
    }

    // 標準Markdown形式: ![alt](path)
    const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    while ((match = mdRegex.exec(content)) !== null) {
        const srcPath = match[2].trim();
        if (srcPath.startsWith('http://') || srcPath.startsWith('https://')) {
            continue;
        }
        const imageInfo = await resolveAndEncodeImage(app, srcPath, fileDir);
        if (imageInfo) {
            images.push(imageInfo);
        }
    }

    return images;
}

async function resolveAndEncodeImage(app: App, imagePath: string, baseDir: string): Promise<ImageInfo | null> {
    const fileName = path.basename(imagePath);
    const imageFile = resolveImageFile(app, imagePath, baseDir);

    if (!imageFile) {
        return {
            fileName,
            localPath: imagePath,
            exists: false
        };
    }

    try {
        const arrayBuffer = await app.vault.readBinary(imageFile);
        const base64 = arrayBufferToBase64(arrayBuffer);
        const mimeType = getMimeType(imageFile.extension);

        return {
            fileName,
            localPath: imageFile.path,
            exists: true,
            base64,
            mimeType
        };
    } catch (e) {
        console.error(`Failed to read image: ${imagePath}`, e);
        return {
            fileName,
            localPath: imagePath,
            exists: false
        };
    }
}

function resolveImageFile(app: App, imagePath: string, baseDir: string): TFile | null {
    const vault = app.vault;

    // リンク解決
    const linkedFile = app.metadataCache.getFirstLinkpathDest(imagePath, baseDir);
    if (linkedFile && linkedFile instanceof TFile) {
        return linkedFile;
    }

    // 直接パス
    const directFile = vault.getAbstractFileByPath(imagePath);
    if (directFile && directFile instanceof TFile) {
        return directFile;
    }

    // 相対パス
    const relativePath = baseDir ? `${baseDir}/${imagePath}` : imagePath;
    const relativeFile = vault.getAbstractFileByPath(relativePath);
    if (relativeFile && relativeFile instanceof TFile) {
        return relativeFile;
    }

    // 一般的なディレクトリを探索
    const commonDirs = ['images', 'attachments', 'assets', 'media', ''];
    const baseName = path.basename(imagePath);
    for (const dir of commonDirs) {
        const tryPath = dir ? `${baseDir}/${dir}/${baseName}` : `${baseDir}/${baseName}`;
        const tryFile = vault.getAbstractFileByPath(tryPath);
        if (tryFile && tryFile instanceof TFile) {
            return tryFile;
        }
        const rootPath = dir ? `${dir}/${baseName}` : baseName;
        const rootFile = vault.getAbstractFileByPath(rootPath);
        if (rootFile && rootFile instanceof TFile) {
            return rootFile;
        }
    }

    return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function getMimeType(extension: string): string {
    const mimeTypes: { [key: string]: string } = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'bmp': 'image/bmp'
    };
    return mimeTypes[extension.toLowerCase()] || 'image/png';
}

// ========================================
// Publish Confirm Modal
// ========================================

class PublishConfirmModal extends Modal {
    private parsedMarkdown: ParsedMarkdown;
    private onConfirm: () => void;
    private onCancel: () => void;

    constructor(app: App, parsedMarkdown: ParsedMarkdown, onConfirm: () => void, onCancel: () => void) {
        super(app);
        this.parsedMarkdown = parsedMarkdown;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('note-publisher-modal');

        contentEl.createEl('h2', { text: 'Publish to note.com' });

        new Setting(contentEl)
            .setName('Title')
            .setDesc(this.parsedMarkdown.title);

        if (this.parsedMarkdown.tags.length > 0) {
            new Setting(contentEl)
                .setName('Tags')
                .setDesc(this.parsedMarkdown.tags.join(', '));
        }

        const eyecatch = this.parsedMarkdown.eyecatch;
        if (eyecatch) {
            new Setting(contentEl)
                .setName('Eyecatch')
                .setDesc(eyecatch.exists ? `✓ ${eyecatch.fileName}` : `✗ ${eyecatch.fileName} (not found)`);
        } else {
            new Setting(contentEl)
                .setName('Eyecatch')
                .setDesc('None (no eyecatch in frontmatter)');
        }

        const images = this.parsedMarkdown.images;
        if (images.length > 0) {
            const imageSection = contentEl.createDiv('image-section');
            imageSection.createEl('h3', { text: `Images (${images.length})` });

            const imageList = imageSection.createDiv('image-list');
            const foundImages = images.filter(i => i.exists);
            const missingImages = images.filter(i => !i.exists);

            foundImages.forEach(img => {
                const item = imageList.createDiv('image-item found');
                item.setText(`✓ ${img.fileName}`);
            });

            missingImages.forEach(img => {
                const item = imageList.createDiv('image-item missing');
                item.setText(`✗ ${img.fileName} (not found)`);
            });

            if (missingImages.length > 0) {
                imageSection.createEl('p', {
                    text: `Warning: ${missingImages.length} image(s) not found and will be skipped.`,
                    cls: 'mod-warning'
                });
            }
        }

        // 本文はHTMLに変換済みのことがあるため、プレビューではタグを除去して表示する
        const plainBody = this.parsedMarkdown.body
            .replace(/<\/(p|h[1-6]|li|blockquote|pre)>/g, ' ')
            .replace(/<br\s*\/?>/g, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const bodyPreview = plainBody.substring(0, 200);
        new Setting(contentEl)
            .setName('Body Preview')
            .setDesc(bodyPreview + (plainBody.length > 200 ? '...' : ''));

        const buttonContainer = contentEl.createDiv('button-container');

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.close();
            this.onCancel();
        });

        const confirmBtn = buttonContainer.createEl('button', {
            text: 'Publish as Draft',
            cls: 'mod-cta'
        });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ========================================
// Settings Tab
// ========================================

class NotePublisherSettingTab extends PluginSettingTab {
    plugin: NotePublisherPlugin;

    constructor(app: App, plugin: NotePublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Note Publisher Settings (v1.2.16)' });

        new Setting(containerEl)
            .setName('MCP Server URL')
            .setDesc('noteMCPサーバーのURL（例: http://127.0.0.1:3000）。localhostではなくIPアドレスを指定してください')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.mcpServerUrl)
                .setValue(this.plugin.settings.mcpServerUrl)
                .onChange(async (value) => {
                    this.plugin.settings.mcpServerUrl = value || DEFAULT_SETTINGS.mcpServerUrl;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Markdown変換 (v1.2.15)')
            .setDesc(
                'このプラグインで変換 = 太字・見出し・箇条書き・コードブロックをHTMLに変換してから送信します（推奨）。' +
                'noteMCPサーバーに任せる = Markdownのまま送信します（サーバーがMarkdown変換に対応していない場合、書式が反映されません）。'
            )
            .addDropdown(dropdown => dropdown
                .addOption('plugin', 'このプラグインで変換（推奨）')
                .addOption('server', 'noteMCPサーバーに任せる')
                .setValue(this.plugin.settings.conversionMode)
                .onChange(async (value) => {
                    this.plugin.settings.conversionMode = (value === 'server' ? 'server' : 'plugin');
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Mode (v1.2.0)')
            .setDesc('API経由で画像を本文に挿入（推奨: ON - 安定・高速）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useApiMode)
                .onChange(async (value) => {
                    this.plugin.settings.useApiMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Headless Mode')
            .setDesc('サーバー側でブラウザを非表示で実行（推奨: ON）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.headlessMode)
                .onChange(async (value) => {
                    this.plugin.settings.headlessMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Open Editor After Publish')
            .setDesc('下書き作成後にnote.comのエディターをブラウザで開く')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openEditorAfterPublish)
                .onChange(async (value) => {
                    this.plugin.settings.openEditorAfterPublish = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Notification')
            .setDesc('成功/エラー時に通知を表示')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNotification)
                .onChange(async (value) => {
                    this.plugin.settings.showNotification = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default Tags')
            .setDesc('毎回自動的に追加するタグ（カンマ区切り）')
            .addText(text => text
                .setPlaceholder('tag1, tag2, tag3')
                .setValue(this.plugin.settings.defaultTags.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.defaultTags = value
                        .split(',')
                        .map(t => t.trim())
                        .filter(t => t.length > 0);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Test Connection')
            .setDesc('MCPサーバーとの接続をテスト')
            .addButton(button => button
                .setButtonText('Test')
                .onClick(async () => {
                    button.setButtonText('Testing...');
                    button.setDisabled(true);
                    try {
                        const response = await fetch(`${this.plugin.settings.mcpServerUrl}/health`);
                        if (response.ok) {
                            button.setButtonText('Success!');
                            setTimeout(() => {
                                button.setButtonText('Test');
                                button.setDisabled(false);
                            }, 2000);
                        } else {
                            throw new Error(`HTTP ${response.status}`);
                        }
                    } catch (e) {
                        button.setButtonText('Failed');
                        setTimeout(() => {
                            button.setButtonText('Test');
                            button.setDisabled(false);
                        }, 2000);
                    }
                }));
    }
}

// ========================================
// Main Plugin
// ========================================

export default class NotePublisherPlugin extends Plugin {
    settings: NotePublisherSettings;
    mcpClient: MCPClient;

    async onload() {
        await this.loadSettings();
        this.mcpClient = new MCPClient(this.settings.mcpServerUrl);

        this.addCommand({
            id: 'publish-to-note',
            name: 'Publish to note.com',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.publishCurrentFile(file);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'publish-to-note-quick',
            name: 'Publish to note.com (Quick - no confirmation)',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.publishCurrentFile(file, true);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addRibbonIcon('upload', 'Publish to note.com', async () => {
            const file = this.app.workspace.getActiveFile();
            if (file && file.extension === 'md') {
                await this.publishCurrentFile(file);
            } else {
                new Notice('Please open a Markdown file to publish');
            }
        });

        this.addSettingTab(new NotePublisherSettingTab(this.app, this));
        console.log('Note Publisher plugin loaded (v1.2.2)');
    }

    onunload() {
        console.log('Note Publisher plugin unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.mcpClient?.setServerUrl(this.settings.mcpServerUrl);
    }

    async publishCurrentFile(file: TFile, skipConfirmation = false) {
        try {
            const parsedMarkdown = await parseMarkdownFile(this.app, file, this.settings.conversionMode);

            if (skipConfirmation) {
                await this.doPublish(parsedMarkdown, file);
            } else {
                new PublishConfirmModal(
                    this.app,
                    parsedMarkdown,
                    () => this.doPublish(parsedMarkdown, file),
                    () => { }
                ).open();
            }
        } catch (error: any) {
            // 起動前のエラーはそのまま表示
            this.handleError(error);
        }
    }

    async doPublish(parsedMarkdown: ParsedMarkdown, file: TFile) {
        const loadingNotice = new Notice('Publishing to note.com...', 0);

        // 投稿開始: status を publishing に変更、publish_error をクリア
        try {
            await updateFrontmatter(this.app, file, {
                status: 'publishing',
                publish_error: ''
            });
            console.log('[Note Publisher] Status changed to: publishing');
        } catch (e) {
            console.error('[Note Publisher] Failed to update frontmatter to publishing:', e);
        }

        try {
            const allTags = [...parsedMarkdown.tags, ...this.settings.defaultTags];
            const uniqueTags = [...new Set(allTags)].slice(0, 10);

            // プラグイン側で変換済みならHTMLとして送り、サーバーの再変換を抑止する
            const bodyFormat: BodyFormat =
                this.settings.conversionMode === 'plugin' ? 'html' : 'markdown';
            console.log(`[Note Publisher] Conversion mode: ${this.settings.conversionMode} (bodyFormat=${bodyFormat})`);

            let result: PublishResult;

            if (this.settings.useApiMode) {
                // v1.2.0: API経由で画像付き下書きを作成
                const validImages = parsedMarkdown.images.filter(i => i.exists && i.base64);
                const imageData = validImages.map(img => ({
                    fileName: img.fileName,
                    base64: img.base64!,
                    mimeType: img.mimeType
                }));

                // アイキャッチ画像を準備
                let eyecatchData: { fileName: string; base64: string; mimeType?: string } | undefined;
                if (parsedMarkdown.eyecatch && parsedMarkdown.eyecatch.exists && parsedMarkdown.eyecatch.base64) {
                    eyecatchData = {
                        fileName: parsedMarkdown.eyecatch.fileName,
                        base64: parsedMarkdown.eyecatch.base64,
                        mimeType: parsedMarkdown.eyecatch.mimeType
                    };
                }

                result = await this.mcpClient.publishWithImages({
                    title: parsedMarkdown.title,
                    markdown: parsedMarkdown.body,
                    tags: uniqueTags,
                    images: imageData,
                    eyecatch: eyecatchData,
                    bodyFormat: bodyFormat
                });
            } else {
                // 従来のpost-draft-note（アイキャッチのみ）
                const requestBody: any = {
                    title: parsedMarkdown.title,
                    markdown: parsedMarkdown.body,
                    tags: uniqueTags,
                    headless: this.settings.headlessMode,
                    saveAsDraft: true,
                    bodyFormat: bodyFormat
                };

                if (parsedMarkdown.eyecatch && parsedMarkdown.eyecatch.exists) {
                    requestBody.eyecatch = {
                        fileName: parsedMarkdown.eyecatch.fileName,
                        base64: parsedMarkdown.eyecatch.base64,
                        mimeType: parsedMarkdown.eyecatch.mimeType
                    };
                }

                result = await this.mcpClient.publishFromObsidianRemote(requestBody);
            }

            loadingNotice.hide();

            if (result.success) {
                // 投稿成功: status を published に変更、note_url をセット
                const cache = this.app.metadataCache.getFileCache(file);
                const existingPublishDate = getPublishDateFromCache(cache);
                
                const successUpdates: Record<string, any> = {
                    status: 'published',
                    publish_error: ''
                };

                // note_url をセット（editUrl または noteUrl）
                if (result.noteUrl) {
                    successUpdates.note_url = result.noteUrl;
                }

                // publish_date が空なら今日の日付を入れる
                if (!existingPublishDate) {
                    successUpdates.publish_date = getTodayDate();
                }

                try {
                    await updateFrontmatter(this.app, file, successUpdates);
                    console.log('[Note Publisher] Status changed to: published');
                } catch (e) {
                    console.error('[Note Publisher] Failed to update frontmatter to published:', e);
                }

                if (this.settings.showNotification) {
                    new Notice(`Draft created: "${result.title}"\n${result.imageCount || 0} image(s) inserted`);
                }
                if (this.settings.openEditorAfterPublish) {
                    window.open('https://note.com/notes', '_blank');
                }
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error: any) {
            loadingNotice.hide();
            
            // 投稿失敗: status を review に戻し、publish_error に理由を記録
            const errorMessage = this.getShortErrorMessage(error);
            try {
                await updateFrontmatter(this.app, file, {
                    status: 'review',
                    publish_error: errorMessage
                });
                console.log(`[Note Publisher] Status changed to: review (error: ${errorMessage})`);
            } catch (e) {
                console.error('[Note Publisher] Failed to update frontmatter on error:', e);
            }
            
            this.handleError(error);
        }
    }

    /**
     * エラーメッセージを短い形式に変換
     */
    getShortErrorMessage(error: any): string {
        const message = error.message || String(error);
        
        if (message.includes('ECONNREFUSED') || message.includes('fetch')) {
            return 'MCP接続失敗';
        }
        if (message.includes('timeout')) {
            return 'タイムアウト';
        }
        if (message.includes('401') || message.includes('認証')) {
            return 'API 401';
        }
        if (message.includes('403')) {
            return 'API 403';
        }
        if (message.includes('500')) {
            return 'API 500';
        }
        if (message.includes('画像') || message.includes('image')) {
            return '画像アップロード失敗';
        }
        
        // 長すぎる場合は切り詰め
        if (message.length > 50) {
            return message.substring(0, 47) + '...';
        }
        return message;
    }

    handleError(error: any) {
        console.error('Note Publisher error:', error);
        let message = 'Failed to publish';

        if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch')) {
            message = `Cannot connect to MCP server at ${this.settings.mcpServerUrl}. Is it running?`;
        } else if (error.message.includes('timeout')) {
            message = 'Operation timed out. Please try again.';
        } else if (error.message.includes('認証')) {
            message = 'Authentication failed. Check MCP server credentials.';
        } else {
            message = `Error: ${error.message}`;
        }

        new Notice(message, 10000);
    }
}
