import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";

// ─── Settings ────────────────────────────────────────────────────────────────

interface GetNoteSyncSettings {
	apiKey: string;
	clientId: string;
	syncFolder: string;
	autoSync: boolean;
	autoSyncInterval: number; // minutes
	noteNameTemplate: string; // "title" | "date-title" | "id-title"
	includeMetadata: boolean;
	lastSyncCursor: string; // since_id for incremental sync
	recentDays: number; // days to re-check for updates on every sync
	// noteIdIndex removed — stored in separate note-index.json
}

const DEFAULT_SETTINGS: GetNoteSyncSettings = {
	apiKey: "",
	clientId: "",
	syncFolder: "GetNotes",
	autoSync: false,
	autoSyncInterval: 30,
	noteNameTemplate: "title",
	includeMetadata: true,
	lastSyncCursor: "0",
	recentDays: 3,
};

// ─── API Types ────────────────────────────────────────────────────────────────

interface GetNoteItem {
	id: string; // int64 as string
	note_id: string;
	title: string;
	content: string;
	note_type: string;
	tags: string[];
	created_at: string;
	updated_at?: string;
}

interface GetNoteDetail extends GetNoteItem {
	web_page?: {
		url?: string;
		content?: string;
		excerpt?: string;
	};
	audio?: {
		original?: string;
		play_url?: string;
		duration?: number;
	};
	attachments?: Array<{
		type: string;
		url?: string;
		original_url?: string;
	}>;
}

interface ListResponse {
	notes: GetNoteItem[];
	has_more: boolean;
	next_cursor: string;
	total: number;
}

// ─── API Client ───────────────────────────────────────────────────────────────

class GetNoteClient {
	private readonly BASE_URL = "https://openapi.biji.com";

	constructor(
		private apiKey: string,
		private clientId: string
	) {}

	private get headers() {
		return {
			Authorization: this.apiKey,
			"X-Client-ID": this.clientId,
			"Content-Type": "application/json",
		};
	}

	/** Parse JSON safely handling int64 IDs */
	private parseJSON(text: string): unknown {
		const safe = text.replace(
			/"(id|note_id|next_cursor|parent_id|follow_id|live_id)"\s*:\s*(\d+)/g,
			'"$1":"$2"'
		);
		return JSON.parse(safe);
	}

	async listNotes(sinceId = "0"): Promise<ListResponse> {
		const resp = await requestUrl({
			url: `${this.BASE_URL}/open/api/v1/resource/note/list?since_id=${sinceId}`,
			headers: this.headers,
		});
		const data = this.parseJSON(resp.text) as {
			success: boolean;
			data: ListResponse;
			error?: { code: number; message: string };
		};
		if (!data.success) {
			throw new Error(data.error?.message ?? "API error");
		}
		return data.data;
	}

	async getNoteDetail(noteId: string): Promise<GetNoteDetail> {
		const resp = await requestUrl({
			url: `${this.BASE_URL}/open/api/v1/resource/note/detail?id=${noteId}`,
			headers: this.headers,
		});
		const data = this.parseJSON(resp.text) as {
			success: boolean;
			data: { note: GetNoteDetail };
			error?: { code: number; message: string };
		};
		if (!data.success) {
			throw new Error(data.error?.message ?? "API error");
		}
		return data.data.note;
	}

	async searchNotes(query: string, topK = 10): Promise<GetNoteItem[]> {
		const resp = await requestUrl({
			url: `${this.BASE_URL}/open/api/v1/resource/recall`,
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({ query, top_k: topK }),
		});
		const data = this.parseJSON(resp.text) as {
			success: boolean;
			data: { results: GetNoteItem[] };
			error?: { code: number; message: string };
		};
		if (!data.success) {
			throw new Error(data.error?.message ?? "API error");
		}
		return data.data.results;
	}
}

// ─── Note Converter ───────────────────────────────────────────────────────────

function noteTypeLabel(type: string): string {
	const map: Record<string, string> = {
		plain_text: "文本",
		link: "链接",
		img_text: "图片",
		audio: "录音",
		meeting: "会议录音",
	};
	return map[type] ?? type;
}

function buildMarkdown(
	note: GetNoteDetail,
	includeMetadata: boolean
): string {
	const lines: string[] = [];

	if (includeMetadata) {
		lines.push("---");
		lines.push(`note_id: "${note.note_id}"`);
		lines.push(`note_type: ${note.note_type}`);
		if (note.tags?.length) {
			lines.push(`tags:`);
			for (const tag of note.tags) {
				lines.push(`  - ${tag}`);
			}
		}
		lines.push(`created_at: ${note.created_at}`);
		if (note.web_page?.url) {
			lines.push(`source: ${note.web_page.url}`);
		}
		lines.push("---");
		lines.push("");
	}

	// Title
	if (note.title) {
		lines.push(`# ${note.title}`);
		lines.push("");
	}

	// Link excerpt
	if (note.web_page?.excerpt) {
		lines.push(`> ${note.web_page.excerpt}`);
		lines.push("");
	}

	// Main content
	if (note.content) {
		lines.push(note.content);
		lines.push("");
	}

	// Web page full content
	if (note.web_page?.content && note.web_page.content !== note.content) {
		lines.push("---");
		lines.push("");
		lines.push("## 原文");
		lines.push("");
		lines.push(note.web_page.content);
		lines.push("");
	}

	// Audio transcript
	if (note.audio?.original) {
		lines.push("## 录音转写");
		lines.push("");
		lines.push(note.audio.original);
		lines.push("");
	}

	return lines.join("\n");
}

function buildFilename(
	note: GetNoteItem,
	template: string
): string {
	const sanitize = (s: string) =>
		s.replace(/[\\/:*?"<>|#^[\]]/g, "_").slice(0, 100).trim();

	const title = sanitize(note.title || `note_${note.note_id}`);
	const date = note.created_at?.slice(0, 10) ?? "";

	if (template === "date-title") return `${date} ${title}`;
	if (template === "id-title") return `${note.note_id} ${title}`;
	return title;
}

// ─── Main Plugin ─────────────────────────────────────────────────────────────

/** Path (relative to vault root) for the large index file */
const INDEX_FILE = ".obsidian/plugins/getnote-sync/note-index.json";

export default class GetNoteSyncPlugin extends Plugin {
	settings!: GetNoteSyncSettings;
	private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

	/** Load note_id → filePath index from its own file (lazy, not in data.json) */
	async loadNoteIndex(): Promise<Map<string, string>> {
		try {
			const raw = await this.app.vault.adapter.read(INDEX_FILE);
			return new Map(Object.entries(JSON.parse(raw)));
		} catch {
			return new Map();
		}
	}

	/** Persist index to its own file */
	async saveNoteIndex(index: Map<string, string>): Promise<void> {
		const obj = Object.fromEntries(index);
		await this.app.vault.adapter.write(INDEX_FILE, JSON.stringify(obj));
	}

	async onload() {
		await this.loadSettings();

		// Ribbon icon
		this.addRibbonIcon("refresh-cw", "Sync Get笔记", () => {
			this.syncNotes();
		});

		// Commands
		this.addCommand({
			id: "sync-all-notes",
			name: "Sync all notes from Get笔记",
			callback: () => this.syncNotes(true),
		});

		this.addCommand({
			id: "sync-incremental",
			name: "Sync new notes from Get笔记 (incremental)",
			callback: () => this.syncNotes(false),
		});

		this.addCommand({
			id: "reset-sync-cursor",
			name: "Reset sync cursor (re-sync all notes next time)",
			callback: async () => {
				this.settings.lastSyncCursor = "0";
				await this.saveSettings();
				new Notice("Sync cursor reset. Next sync will fetch all notes.");
			},
		});

		// Settings tab
		this.addSettingTab(new GetNoteSyncSettingTab(this.app, this));

		// Auto sync
		this.setupAutoSync();
	}

	onunload() {
		this.clearAutoSync();
	}

	setupAutoSync() {
		this.clearAutoSync();
		if (this.settings.autoSync && this.settings.autoSyncInterval > 0) {
			const ms = this.settings.autoSyncInterval * 60 * 1000;
			this.autoSyncTimer = setInterval(() => this.syncNotes(), ms);
		}
	}

	clearAutoSync() {
		if (this.autoSyncTimer !== null) {
			clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Find the smallest note_id among local files created within the last N days */
	private async findRecentCursor(folder: string, days: number): Promise<string | null> {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - days);
		const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

		let minId = "";
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folder + "/")) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const createdAt: string = cache?.frontmatter?.created_at ?? "";
			const noteId: string = String(cache?.frontmatter?.note_id ?? "");
			if (noteId && createdAt.slice(0, 10) >= cutoffStr) {
				if (!minId || noteId < minId) minId = noteId;
			}
		}
		return minId || null;
	}

	async syncNotes(fullSync = false) {
		if (!this.settings.apiKey || !this.settings.clientId) {
			new Notice("⚠️ Please configure your Get笔记 API Key and Client ID in settings.");
			return;
		}

		const client = new GetNoteClient(
			this.settings.apiKey,
			this.settings.clientId
		);

		const sinceId = fullSync ? "0" : this.settings.lastSyncCursor;
		const notice = new Notice(
			`🔄 Syncing Get笔记 notes${fullSync ? " (full)" : ""}...`,
			0
		);

		try {
			let cursor = sinceId;
			let totalFetched = 0;
			let totalWritten = 0;
			let totalSkipped = 0;

			// Ensure sync folder exists
			const folder = normalizePath(this.settings.syncFolder);
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}

			// Load persisted note_id → filePath index from separate file
			const noteIdIndex = await this.loadNoteIndex();

			/**
			 * Resolve file path for a note (from index or create new).
			 * Returns the path and whether the file already existed.
			 */
			const resolvePath = async (note: GetNoteItem): Promise<string> => {
				let filePath = noteIdIndex.get(note.note_id);
				if (filePath && !(await this.app.vault.adapter.exists(filePath))) {
					filePath = undefined;
				}
				if (!filePath) {
					const filename = buildFilename(note, this.settings.noteNameTemplate);
					// Place in YYYY/MM subfolder based on created_at
					const dateStr = note.created_at?.slice(0, 7) ?? ""; // "YYYY-MM"
					const [year, month] = dateStr ? dateStr.split("-") : ["unknown", "unknown"];
					const subFolder = normalizePath(`${folder}/${year || "unknown"}/${month || "unknown"}`);
					if (!(await this.app.vault.adapter.exists(subFolder))) {
						await this.app.vault.createFolder(subFolder);
					}
					filePath = normalizePath(`${subFolder}/${filename}.md`);
					if (await this.app.vault.adapter.exists(filePath)) {
						filePath = normalizePath(`${subFolder}/${filename}.${note.note_id}.md`);
					}
					noteIdIndex.set(note.note_id, filePath);
				}
				return filePath;
			};

			/** Returns true if this note should be skipped */
			const shouldSkip = (note: GetNoteItem): boolean => {
				if (note.title?.startsWith("(冲突笔记)")) return true;
				// Skip notes before 2014
				if (note.created_at && note.created_at.slice(0, 4) < "2014") return true;
				// Skip notes with content under 200 characters
				if ((note.content ?? "").length < 200) return true;
				// Skip notes tagged with #得到
				if ((note.content ?? "").includes("#得到") || (note.title ?? "").includes("#得到")) return true;
				return false;
			};

			/** Always write (new notes pass) */
			const writeNote = async (note: GetNoteItem): Promise<void> => {
				if (shouldSkip(note)) return;
				totalFetched++;
				const filePath = await resolvePath(note);
				const content = buildMarkdown(note as GetNoteDetail, this.settings.includeMetadata);
				await this.app.vault.adapter.write(filePath, content);
				totalWritten++;
			};

			/** Compare before write (recent notes pass) */
			const compareAndWrite = async (note: GetNoteItem): Promise<void> => {
				if (shouldSkip(note)) return;
				totalFetched++;
				const filePath = await resolvePath(note);
				const newContent = buildMarkdown(note as GetNoteDetail, this.settings.includeMetadata);

				// Read existing file and compare; skip write if identical
				const fileExists = await this.app.vault.adapter.exists(filePath);
				if (fileExists) {
					const existing = await this.app.vault.adapter.read(filePath);
					if (existing === newContent) {
						totalSkipped++;
						return;
					}
				}
				await this.app.vault.adapter.write(filePath, newContent);
				totalWritten++;
			};

			/** Paginate through API with pipeline fetch + parallel writes */
			const paginate = async (
				fromCursor: string,
				handler: (note: GetNoteItem) => Promise<void>
			): Promise<string> => {
				let cur = fromCursor;
				let nextPage: Promise<ListResponse> = client.listNotes(cur);
				while (true) {
					const page = await nextPage;
					if (page.has_more && page.notes.length > 0) {
						cur = page.notes[page.notes.length - 1].note_id;
						nextPage = client.listNotes(cur);
					}
					await Promise.all(page.notes.map(handler));
					if (page.notes.length > 0 && !page.has_more) {
						cur = page.notes[page.notes.length - 1].note_id;
					}
					if (!page.has_more) break;
				}
				return cur;
			};

			// ── Phase 1: Re-check recent N days for updates ──────────────────────
			if (!fullSync && this.settings.recentDays > 0) {
				const recentCursor = await this.findRecentCursor(folder, this.settings.recentDays);
				if (recentCursor) {
					// Use a cursor one step before to include the boundary note
					const prevCursor = String(BigInt(recentCursor) - BigInt(1));
					await paginate(prevCursor, compareAndWrite);
				}
			}

			// ── Phase 2: Fetch truly new notes (after last cursor) ───────────────
			const newCursor = await paginate(cursor, writeNote);
			if (newCursor !== "0") cursor = newCursor;

			// Persist index to its own file, cursor to data.json
			await this.saveNoteIndex(noteIdIndex);
			if (cursor !== "0") {
				this.settings.lastSyncCursor = cursor;
			}
			await this.saveSettings();

			notice.hide();
			new Notice(
				`✅ ${totalWritten} 条已更新，${totalSkipped} 条无变化，共处理 ${totalFetched} 条`
			);
		} catch (err) {
			notice.hide();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`❌ Sync failed: ${msg}`);
			console.error("[GetNote Sync]", err);
		}
	}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class GetNoteSyncSettingTab extends PluginSettingTab {
	plugin: GetNoteSyncPlugin;

	constructor(app: App, plugin: GetNoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Get笔记 Sync Settings" });

		// ── Credentials ──────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "API Credentials" });
		containerEl.createEl("p", {
			text: "Get your API Key and Client ID from biji.com/openapi",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Format: gk_live_xxx")
			.addText((text) =>
				text
					.setPlaceholder("gk_live_...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Format: cli_xxx")
			.addText((text) =>
				text
					.setPlaceholder("cli_...")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// ── Sync Folder ───────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync Settings" });

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Folder in your vault where notes will be saved")
			.addText((text) =>
				text
					.setPlaceholder("GetNotes")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim() || "GetNotes";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Note filename format")
			.setDesc("How to name synced note files")
			.addDropdown((drop) =>
				drop
					.addOption("title", "Title only")
					.addOption("date-title", "Date + Title (2025-01-01 My Note)")
					.addOption("id-title", "ID + Title (123456 My Note)")
					.setValue(this.plugin.settings.noteNameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.noteNameTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include YAML frontmatter")
			.setDesc("Add note metadata (id, type, tags, date) as YAML frontmatter")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeMetadata)
					.onChange(async (value) => {
						this.plugin.settings.includeMetadata = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("近期更新检查天数")
			.setDesc("每次同步时重新拉取最近 N 天创建的笔记，与本地对比，有差异才落档（0 = 不检查）")
			.addSlider((slider) =>
				slider
					.setLimits(0, 14, 1)
					.setValue(this.plugin.settings.recentDays)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.recentDays = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Auto Sync ─────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Auto Sync" });

		new Setting(containerEl)
			.setName("Enable auto sync")
			.setDesc("Automatically sync notes at a regular interval")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSync)
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value;
						await this.plugin.saveSettings();
						this.plugin.setupAutoSync();
					})
			);

		new Setting(containerEl)
			.setName("Auto sync interval (minutes)")
			.setDesc("How often to sync automatically (minimum 5 minutes)")
			.addSlider((slider) =>
				slider
					.setLimits(5, 120, 5)
					.setValue(this.plugin.settings.autoSyncInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autoSyncInterval = value;
						await this.plugin.saveSettings();
						this.plugin.setupAutoSync();
					})
			);

		// ── Actions ───────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Sync now (incremental)")
			.setDesc("Fetch notes added since last sync")
			.addButton((btn) =>
				btn
					.setButtonText("Sync")
					.setCta()
					.onClick(() => this.plugin.syncNotes(false))
			);

		new Setting(containerEl)
			.setName("Full sync")
			.setDesc("Re-fetch all notes from the beginning")
			.addButton((btn) =>
				btn.setButtonText("Full Sync").onClick(() => this.plugin.syncNotes(true))
			);

		new Setting(containerEl)
			.setName("Reset sync cursor")
			.setDesc("Reset progress so next sync fetches all notes")
			.addButton((btn) =>
				btn.setButtonText("Reset").onClick(async () => {
					this.plugin.settings.lastSyncCursor = "0";
					await this.plugin.saveSettings();
					new Notice("Sync cursor reset.");
				})
			);

		// ── Status ─────────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Status" });
		const cursor = this.plugin.settings.lastSyncCursor;
		containerEl.createEl("p", {
			text: cursor === "0"
				? "No sync performed yet."
				: `Last sync cursor: ${cursor}`,
			cls: "setting-item-description",
		});
	}
}
