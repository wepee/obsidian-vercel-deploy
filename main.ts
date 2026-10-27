import { App, Plugin, Notice, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';

// ─── Types ───────────────────────────────────────────────────────────────────

interface VercelDeploySettings {
	vercelToken: string;
	teamId: string;
	/** Vercel project that hosts every share, one deployment per share. */
	projectName: string;
	/** Prepended to each share's subdomain: `<prefix><slug>.vercel.app`. */
	subdomainPrefix: string;
	/** Map of vault paths (folder or HTML file) → subdomain host. */
	shares: Record<string, string>;
}

interface DeployFile {
	file: string;
	data: string;
	encoding: 'base64' | 'utf-8';
}

/** What gets deployed: a whole folder with its index.html, or one HTML file. */
interface Share {
	kind: 'folder' | 'file';
	/** Vault path of the folder or file, used as the share's key. */
	path: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: VercelDeploySettings = {
	vercelToken: '',
	teamId: '',
	projectName: 'second-brain',
	subdomainPrefix: 'sb-',
	shares: {},
};

const IGNORE_NAMES = new Set(['.DS_Store', 'node_modules', '.git', '.vercel', '.obsidian']);
const IGNORE_EXTENSIONS = new Set(['.md', '.canvas', '.base']);

// A DNS label is at most 63 characters.
const MAX_SUBDOMAIN_LENGTH = 63;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shouldIgnore(name: string): boolean {
	if (name.startsWith('.')) return true;
	if (IGNORE_NAMES.has(name)) return true;
	const dot = name.lastIndexOf('.');
	if (dot !== -1 && IGNORE_EXTENSIONS.has(name.slice(dot))) return true;
	return false;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFD')
		// Strip accents, then emojis and symbols outside basic Latin
		.replace(/[̀-ͯ]/g, '')
		.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{200D}\u{20E3}\u{FE0F}]/gu, '')
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'untitled';
}

function subdomainFor(prefix: string, slug: string): string {
	return `${prefix}${slug}`
		.substring(0, MAX_SUBDOMAIN_LENGTH)
		.replace(/-+$/, '');
}

/** Short stable hash, used to disambiguate a subdomain already taken. */
function shortHash(value: string): string {
	let h = 0;
	for (let i = 0; i < value.length; i++) {
		h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36).slice(0, 5);
}

function parentPath(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

/** Resolves `relative` against `base`; null when it climbs out of the vault. */
function resolveRelative(base: string, relative: string): string | null {
	const parts = base ? base.split('/') : [];
	for (const segment of relative.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(segment);
		}
	}
	return parts.join('/');
}

/** Local paths an HTML page links to (src, href, poster), without query or hash. */
function localReferences(html: string): string[] {
	const refs = new Set<string>();
	const pattern = /(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi;
	let match;
	while ((match = pattern.exec(html)) !== null) {
		const raw = match[1].trim();
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(raw)) continue;
		const path = raw.split(/[?#]/)[0];
		if (!path) continue;
		try {
			refs.add(decodeURIComponent(path));
		} catch {
			refs.add(path);
		}
	}
	return [...refs];
}

/** Web-compatible base64 encoding (no Node.js Buffer needed → works on mobile). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class VercelDeployPlugin extends Plugin {
	settings: VercelDeploySettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'deploy-active-folder',
			name: 'Share on Vercel',
			callback: () => this.deployActive(),
		});

		this.addSettingTab(new VercelDeploySettingTab(this.app, this));
	}

	// ── Deploy flow ──────────────────────────────────────────────────────────

	async deployActive() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('Open an HTML file, or a note inside the folder to share.');
			return;
		}

		if (!this.settings.vercelToken) {
			new Notice('Vercel token missing — set it in the plugin settings.');
			return;
		}

		const share = await this.resolveShare(activeFile);
		if (!share) return;

		const notice = new Notice(`Collecting files from "${share.path}"…`, 0);

		try {
			const files = share.kind === 'folder'
				? await this.collectFiles(share.path)
				: await this.collectHtmlFile(share.path);

			if (files.length === 0) {
				notice.hide();
				new Notice('No web files found to share.');
				return;
			}

			// Inject vercel.json so pages are public but not indexed
			files.push({
				file: 'vercel.json',
				data: btoa(JSON.stringify({
					headers: [{
						source: '/(.*)',
						headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
					}],
				})),
				encoding: 'base64',
			});

			notice.setMessage(`Deploying ${files.length} file(s) to ${this.settings.projectName}…`);

			const deploymentId = await this.deploy(files);
			await this.pollUntilReady(deploymentId, notice);

			notice.setMessage('Assigning the share URL…');
			const host = await this.assignShareAlias(share, deploymentId);

			this.settings.shares[share.path] = host;
			await this.saveSettings();

			notice.hide();
			this.showSuccessNotice(`https://${host}`, share.path);
		} catch (err) {
			notice.hide();
			new Notice(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * An HTML file other than index.html is shared on its own. Anything else
	 * shares its folder, which needs an index.html — or a single HTML file,
	 * shared on its own.
	 */
	async resolveShare(activeFile: TFile): Promise<Share | null> {
		if (activeFile.extension === 'html' && activeFile.name !== 'index.html') {
			return { kind: 'file', path: activeFile.path };
		}

		const folderPath = activeFile.parent?.path ?? '/';
		const indexPath = folderPath === '/' ? 'index.html' : `${folderPath}/index.html`;
		if (await this.app.vault.adapter.exists(indexPath)) {
			return { kind: 'folder', path: folderPath };
		}

		const listing = await this.app.vault.adapter.list(folderPath === '/' ? '' : folderPath);
		const htmlFiles = listing.files.filter(f => f.toLowerCase().endsWith('.html'));
		if (htmlFiles.length === 1) {
			return { kind: 'file', path: htmlFiles[0] };
		}

		new Notice(htmlFiles.length === 0
			? `No HTML file found in "${folderPath}".`
			: `Several HTML files in "${folderPath}": open the one to share.`);
		return null;
	}

	// ── File collection ──────────────────────────────────────────────────────

	async collectFiles(vaultFolderPath: string): Promise<DeployFile[]> {
		const adapter = this.app.vault.adapter;
		const files: DeployFile[] = [];

		const walk = async (currentVaultPath: string, deployBasePath: string) => {
			let listing;
			try {
				listing = await adapter.list(currentVaultPath);
			} catch {
				return;
			}

			for (const filePath of listing.files) {
				const fileName = filePath.split('/').pop()!;
				if (shouldIgnore(fileName)) continue;

				const deployPath = deployBasePath
					? `${deployBasePath}/${fileName}`
					: fileName;

				try {
					const buffer = await adapter.readBinary(filePath);
					files.push({
						file: deployPath,
						data: arrayBufferToBase64(buffer),
						encoding: 'base64',
					});
				} catch {
					// Skip unreadable files silently
				}
			}

			for (const subFolderPath of listing.folders) {
				const subFolderName = subFolderPath.split('/').pop()!;
				if (shouldIgnore(subFolderName)) continue;
				const subDeployBase = deployBasePath
					? `${deployBasePath}/${subFolderName}`
					: subFolderName;
				await walk(subFolderPath, subDeployBase);
			}
		};

		await walk(vaultFolderPath, '');
		return files;
	}

	/**
	 * One HTML file, served at the root of its share under its own name too,
	 * plus the local files it links to (images, CSS, scripts, other pages).
	 * The rest of its folder stays private.
	 */
	async collectHtmlFile(htmlPath: string): Promise<DeployFile[]> {
		const adapter = this.app.vault.adapter;
		const baseFolder = parentPath(htmlPath);
		const html = await adapter.read(htmlPath);
		const data = arrayBufferToBase64(await adapter.readBinary(htmlPath));
		const fileName = htmlPath.split('/').pop()!;

		const files: DeployFile[] = [{ file: 'index.html', data, encoding: 'base64' }];
		const deployed = new Set(['index.html']);
		if (fileName !== 'index.html') {
			files.push({ file: fileName, data, encoding: 'base64' });
			deployed.add(fileName);
		}

		for (const ref of localReferences(html)) {
			const deployPath = resolveRelative('', ref);
			const vaultPath = resolveRelative(baseFolder, ref);
			if (!deployPath || vaultPath === null || deployed.has(deployPath)) continue;
			if (deployPath.split('/').some(shouldIgnore)) continue;

			const stat = await adapter.stat(normalizePath(vaultPath));
			if (stat?.type !== 'file') continue;

			files.push({
				file: deployPath,
				data: arrayBufferToBase64(await adapter.readBinary(normalizePath(vaultPath))),
				encoding: 'base64',
			});
			deployed.add(deployPath);
		}

		return files;
	}

	// ── Vercel API ───────────────────────────────────────────────────────────

	private get teamQuery(): string {
		const { teamId } = this.settings;
		return teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
	}

	private async api(method: string, path: string, body?: unknown) {
		return requestUrl({
			url: `https://api.vercel.com${path}${this.teamQuery}`,
			method,
			headers: {
				Authorization: `Bearer ${this.settings.vercelToken}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});
	}

	/**
	 * Creates a preview deployment in the shared project. Previews carrying a
	 * custom alias are exempt from Vercel's retention policy, so a share stays
	 * up for as long as its alias points to it.
	 */
	async deploy(files: DeployFile[]): Promise<string> {
		const { projectName } = this.settings;

		const res = await this.api('POST', '/v13/deployments', {
			name: projectName,
			project: projectName,
			files,
			projectSettings: {
				framework: null,
				outputDirectory: null,
				installCommand: null,
				buildCommand: null,
			},
		});

		if (res.status >= 400) {
			const msg = res.json?.error?.message || `HTTP ${res.status}`;
			throw new Error(msg);
		}

		await this.disableDeploymentProtection();
		return res.json.id;
	}

	async disableDeploymentProtection(): Promise<void> {
		await this.api('PATCH', `/v9/projects/${encodeURIComponent(this.settings.projectName)}`, {
			passwordProtection: null,
			ssoProtection: null,
		});
	}

	async pollUntilReady(deploymentId: string, notice: Notice): Promise<void> {
		const maxAttempts = 90; // ~3 min

		for (let i = 0; i < maxAttempts; i++) {
			await sleep(2000);

			const res = await this.api('GET', `/v13/deployments/${deploymentId}`);
			if (res.status >= 400) continue;

			const { readyState } = res.json;
			notice.setMessage(`Deploying… (${readyState})`);

			if (readyState === 'READY') return;
			if (readyState === 'ERROR' || readyState === 'CANCELED') {
				throw new Error(`Deployment failed (${readyState}).`);
			}
		}

		throw new Error('Deployment still not ready after 3 minutes.');
	}

	/**
	 * Points the share's subdomain at the new deployment. A share keeps the
	 * subdomain it got the first time; a new one is derived from its vault
	 * path, with a short hash appended if someone else already owns it.
	 */
	async assignShareAlias(share: Share, deploymentId: string): Promise<string> {
		const known = this.settings.shares[share.path];
		const slug = slugify(share.kind === 'file'
			? share.path.replace(/\.html$/i, '')
			: share.path);
		const base = subdomainFor(this.settings.subdomainPrefix, slug);
		const hashed = subdomainFor(
			this.settings.subdomainPrefix,
			`${slug.substring(0, MAX_SUBDOMAIN_LENGTH - this.settings.subdomainPrefix.length - 6)}-${shortHash(share.path)}`,
		);
		const takenByOtherShare = (host: string) => Object.entries(this.settings.shares)
			.some(([path, h]) => h === host && path !== share.path);

		const candidates = known
			? [known]
			: [`${base}.vercel.app`, `${hashed}.vercel.app`].filter(h => !takenByOtherShare(h));

		let lastError = 'no subdomain available';
		for (const host of candidates) {
			const res = await this.api('POST', `/v2/deployments/${deploymentId}/aliases`, { alias: host });
			if (res.status < 400 || res.json?.error?.code === 'not_modified') return host;
			lastError = res.json?.error?.message || `HTTP ${res.status}`;
		}
		throw new Error(`Could not assign the share URL: ${lastError}`);
	}

	// ── Success notice ───────────────────────────────────────────────────────

	showSuccessNotice(url: string, sharePath: string) {
		navigator.clipboard?.writeText(url).catch(() => { /* clipboard unavailable */ });

		const frag = document.createDocumentFragment();

		const title = createDiv({ cls: 'vercel-deploy-success-title' });
		title.textContent = `"${sharePath}" is live! Link copied.`;
		frag.appendChild(title);

		const link = createEl('a', { cls: 'vercel-deploy-success-link', href: url });
		link.textContent = url;
		link.addEventListener('click', (e) => {
			e.preventDefault();
			window.open(url, '_blank');
		});
		frag.appendChild(link);

		new Notice(frag, 20000);
	}

	// ── Settings persistence ─────────────────────────────────────────────────

	async loadSettings() {
		const data = await this.loadData() ?? {};
		// Folder → URL map from the one-project-per-folder era; those projects are gone
		delete data.deployedProjects;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.shares = { ...this.settings.shares };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ─── Settings tab ────────────────────────────────────────────────────────────

class VercelDeploySettingTab extends PluginSettingTab {
	plugin: VercelDeployPlugin;

	constructor(app: App, plugin: VercelDeployPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'Generate your token at vercel.com → Account settings → Tokens.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Vercel token')
			.setDesc('Authentication token for the Vercel API.')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.vercelToken)
					.onChange(async (value) => {
						this.plugin.settings.vercelToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Team ID')
			.setDesc('Only needed when deploying to a Vercel team account.')
			.addText(text => text
				.setPlaceholder('team_xxxxxxxxxx')
				.setValue(this.plugin.settings.teamId)
				.onChange(async (value) => {
					this.plugin.settings.teamId = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Project')
			.setDesc('Vercel project that hosts every share, one deployment each.')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.projectName)
				.setValue(this.plugin.settings.projectName)
				.onChange(async (value) => {
					this.plugin.settings.projectName = value.trim() || DEFAULT_SETTINGS.projectName;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Subdomain prefix')
			.setDesc('Each share lives at <prefix><vault path>.vercel.app.')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.subdomainPrefix)
				.setValue(this.plugin.settings.subdomainPrefix)
				.onChange(async (value) => {
					this.plugin.settings.subdomainPrefix = slugify(value) === 'untitled' ? '' : `${slugify(value)}-`;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ignored files')
			.setHeading();

		containerEl.createEl('p', {
			text: 'The plugin automatically ignores hidden files, .obsidian, .git, node_modules, and .md, .canvas, .base files.',
			cls: 'setting-item-description',
		});
	}
}
