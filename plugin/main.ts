import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import * as path from 'path';

// ========================================
// Types
// ========================================

interface NotePublisherSettings {
    mcpServerUrl: string;
    headlessMode: boolean;
    openEditorAfterPublish: boolean;
    showNotification: boolean;
    defaultTags: string[];
    useApiMode: boolean;  // v1.2.0: API経由での画像挿入
}

const DEFAULT_SETTINGS: NotePublisherSettings = {
    mcpServerUrl: 'http://127.0.0.1:3000',
    headlessMode: true,
    openEditorAfterPublish: true,
    showNotification: true,
    defaultTags: [],
    useApiMode: true  // v1.2.0: デフォルトでAPI経由
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
 * frontmatterを更新する
 * @param app Obsidian App
 * @param file 対象ファイル
 * @param updates 更新するフィールド
 */
async function updateFrontmatter(app: App, file: TFile, updates: Record<string, any>): Promise<void> {
    const content = await app.vault.read(file);
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
    const match = content.match(frontmatterRegex);

    let newContent: string;

    if (match) {
        // 既存のfrontmatterを解析
        const frontmatterStr = match[1];
        const frontmatterLines = frontmatterStr.split('\n');
        const frontmatterObj: Record<string, any> = {};

        // 簡易YAML解析（単純なkey: value形式のみ対応）
        for (const line of frontmatterLines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();
                // クォートを除去
                if ((value.startsWith('"') && value.endsWith('"')) || 
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                frontmatterObj[key] = value;
            }
        }

        // 更新を適用
        for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined) {
                delete frontmatterObj[key];
            } else {
                frontmatterObj[key] = value;
            }
        }

        // frontmatterを再構築
        const newFrontmatterLines: string[] = [];
        for (const [key, value] of Object.entries(frontmatterObj)) {
            if (value === '' || value === null || value === undefined) {
                // 空文字列の場合はキーのみ出力
                newFrontmatterLines.push(`${key}: ""`);
            } else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
                // 特殊文字を含む場合はクォート
                newFrontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
            } else {
                newFrontmatterLines.push(`${key}: ${value}`);
            }
        }

        const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n`;
        newContent = content.replace(frontmatterRegex, newFrontmatter);
    } else {
        // frontmatterがない場合は新規作成
        const newFrontmatterLines: string[] = [];
        for (const [key, value] of Object.entries(updates)) {
            if (value !== null && value !== undefined) {
                if (value === '') {
                    newFrontmatterLines.push(`${key}: ""`);
                } else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
                    newFrontmatterLines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
                } else {
                    newFrontmatterLines.push(`${key}: ${value}`);
                }
            }
        }
        const newFrontmatter = `---\n${newFrontmatterLines.join('\n')}\n---\n\n`;
        newContent = newFrontmatter + content;
    }

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
    }): Promise<PublishResult> {
        try {
            console.log(`[Note Publisher] Using post-draft-note-with-images (API mode)`);

            const toolArgs: any = {
                title: params.title,
                body: params.markdown,
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
    }): Promise<PublishResult> {
        const hasEyecatch = params.eyecatch && params.eyecatch.base64;
        try {
            console.log(`[Note Publisher] Using post-draft-note (eyecatch: ${hasEyecatch ? 'yes' : 'no'})`);

            const toolArgs: any = {
                title: params.title,
                body: params.markdown,
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

async function parseMarkdownFile(app: App, file: TFile): Promise<ParsedMarkdown> {
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);

    const title = extractTitle(content, file, cache);
    const tags = extractTags(cache);
    const fileDir = file.parent?.path || '';
    const eyecatch = await extractEyecatch(app, cache, fileDir);
    const body = prepareBody(content);
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
    const h1Match = content.match(/^#\s+(.+)$/m);
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

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function prepareBody(content: string): string {
    let body = content;
    body = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    body = body.replace(/^#\s+.+\n?/, '');

    // コードブロックを先にプレースホルダーに退避（他の変換の影響を防ぐ）
    const codeBlocks: string[] = [];
    body = body.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
        codeBlocks.push(`<pre><code>${code.trimEnd()}</code></pre>`);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // 見出し（UUID付き）
    body = body.replace(/^### (.+)$/gm, (_, text) =>
        `<h3 name="${generateUUID()}" id="${generateUUID()}">${text}</h3>`);
    body = body.replace(/^## (.+)$/gm, (_, text) =>
        `<h2 name="${generateUUID()}" id="${generateUUID()}">${text}</h2>`);

    // 引用（UUID付き、空行・スペースあり/なし対応）
    body = body.replace(/(^>[ ]?.*$\n?)+/gm, (match) => {
        const lines = match.trim().split('\n')
            .map(line => line.replace(/^>[ ]?/, ''))
            .filter(line => line !== '');
        const uuid = generateUUID();
        return `<blockquote name="${uuid}" id="${uuid}">${lines.join('<br>')}</blockquote>`;
    });

    // 区切り線
    body = body.replace(/^---+$/gm, '<hr>');

    // インラインコード
    body = body.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 太字
    body = body.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 斜体
    body = body.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    // 段落分割（UUID付き）
    body = body.split('\n\n').map(para => {
        para = para.trim();
        if (para === '') return '';
        if (para.startsWith('<')) return para;
        if (para.match(/^__CODE_BLOCK_\d+__$/)) return para;
        const formattedPara = para.replace(/\n/g, '<br>');
        return `<p name="${generateUUID()}" id="${generateUUID()}">${formattedPara}</p>`;
    }).join('');

    // コードブロックを復元
    codeBlocks.forEach((block, i) => {
        body = body.replace(`__CODE_BLOCK_${i}__`, block);
    });

    return body.trim();
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

        const bodyPreview = this.parsedMarkdown.body.substring(0, 200);
        new Setting(contentEl)
            .setName('Body Preview')
            .setDesc(bodyPreview + (this.parsedMarkdown.body.length > 200 ? '...' : ''));

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

        containerEl.createEl('h2', { text: 'Note Publisher Settings (v1.2.2)' });

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
            const parsedMarkdown = await parseMarkdownFile(this.app, file);

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
                    eyecatch: eyecatchData
                });
            } else {
                // 従来のpost-draft-note（アイキャッチのみ）
                const requestBody: any = {
                    title: parsedMarkdown.title,
                    markdown: parsedMarkdown.body,
                    tags: uniqueTags,
                    headless: this.settings.headlessMode,
                    saveAsDraft: true
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
