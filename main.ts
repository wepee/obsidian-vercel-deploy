import { App, Plugin, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';

// ─── Types ───────────────────────────────────────────────────────────────────

interface VercelDeploySettings {
	vercelToken: string;
	teamId: string;
	/** Map of vault folder paths → deployed URLs. */
	deployedProjects: Record<string, string>;
}

interface DeployFile {
	file: string;
	data: string;
	encoding: 'base64' | 'utf-8';
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: VercelDeploySettings = {
	vercelToken: '',
	teamId: '',
	deployedProjects: {},
};

const IGNORE_NAMES = new Set(['.DS_Store', 'node_modules', '.git', '.vercel', '.obsidian']);
const IGNORE_EXTENSIONS = new Set(['.md', '.canvas', '.base']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shouldIgnore(name: string): boolean {
	if (name.startsWith('.')) return true;
	if (IGNORE_NAMES.has(name)) return true;
	const dot = name.lastIndexOf('.');
	if (dot !== -1 && IGNORE_EXTENSIONS.has(name.slice(dot))) return true;
	return false;
}

function sanitizeProjectName(name: string): string {
	return name
		.toLowerCase()
		// Strip emojis and symbols outside basic Latin
		.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{200D}\u{20E3}\u{FE0F}]/gu, '')
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.substring(0, 52) || 'untitled';
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
			name: 'Deploy active folder to Vercel',
			callback: () => this.deployActiveFolder(),
		});

		this.addSettingTab(new VercelDeploySettingTab(this.app, this));
	}

	// ── Deploy flow ──────────────────────────────────────────────────────────

	async deployActiveFolder() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('Open a note inside the folder to deploy.');
			return;
		}

		if (!this.settings.vercelToken) {
			new Notice('Vercel token missing — set it in the plugin settings.');
			return;
		}

		const folder = activeFile.parent;
		const folderVaultPath = folder ? folder.path : '/';
		const folderPath = folder ? folder.path : this.app.vault.getName();
		const projectName = sanitizeProjectName(folderPath);

		// Guard: a valid static site needs an index.html
		const indexPath = folderVaultPath === '/'
			? 'index.html'
			: `${folderVaultPath}/index.html`;

		const hasIndex = await this.app.vault.adapter.exists(indexPath);
		if (!hasIndex) {
			new Notice(`No index.html found in "${folderPath}".`);
			return;
		}

		const notice = new Notice(`Collecting files from "${folderPath}"…`, 0);

		try {
			const files = await this.collectFiles(folderVaultPath);

			if (files.length === 0) {
				notice.hide();
				new Notice('No web files found in this folder.');
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

			notice.setMessage(`Deploying ${files.length} file(s) to ${projectName}.vercel.app…`);

			const deployedUrl = await this.deploy(projectName, files, notice);

			// Track the successful deployment
			this.settings.deployedProjects[folderPath] = deployedUrl;
			await this.saveSettings();

			notice.hide();
			this.showSuccessNotice(deployedUrl, projectName);
		} catch (err) {
			notice.hide();
			new Notice(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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

	// ── Vercel API ───────────────────────────────────────────────────────────

	async deploy(projectName: string, files: DeployFile[], notice: Notice): Promise<string> {
		const { vercelToken: token, teamId } = this.settings;
		const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';

		const body = {
			name: projectName,
			files,
			target: 'production',
			projectSettings: {
				framework: null,
				outputDirectory: null,
				installCommand: null,
				buildCommand: null,
			},
		};

		const res = await requestUrl({
			url: `https://api.vercel.com/v13/deployments${qs}`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			throw: false,
		});

		if (res.status >= 400) {
			const msg = res.json?.error?.message || `HTTP ${res.status}`;
			throw new Error(msg);
		}

		const { id: deploymentId } = res.json;
		await this.disableDeploymentProtection(projectName, token, teamId);
		return this.pollUntilReady(deploymentId, projectName, token, teamId, notice);
	}

	async disableDeploymentProtection(
		projectName: string,
		token: string,
		teamId: string,
	): Promise<void> {
		const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
		await requestUrl({
			url: `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}${qs}`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				passwordProtection: null,
				ssoProtection: null,
			}),
			throw: false,
		});
	}

	async pollUntilReady(
		deploymentId: string,
		projectName: string,
		token: string,
		teamId: string,
		notice: Notice,
	): Promise<string> {
		const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
		const maxAttempts = 90; // ~3 min

		for (let i = 0; i < maxAttempts; i++) {
			await sleep(2000);

			const res = await requestUrl({
				url: `https://api.vercel.com/v13/deployments/${deploymentId}${qs}`,
				method: 'GET',
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});

			if (res.status >= 400) continue;

			const { readyState, alias, url } = res.json;
			notice.setMessage(`Deploying… (${readyState})`);

			if (readyState === 'READY') {
				return alias?.length
					? `https://${alias[0]}`
					: `https://${url}`;
			}

			if (readyState === 'ERROR' || readyState === 'CANCELED') {
				throw new Error(`Deployment failed (${readyState}).`);
			}
		}

		return `https://${projectName}.vercel.app`;
	}

	// ── Success notice ───────────────────────────────────────────────────────

	showSuccessNotice(url: string, projectName: string) {
		const frag = document.createDocumentFragment();

		const title = createDiv({ cls: 'vercel-deploy-success-title' });
		title.textContent = `"${projectName}" is live!`;
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			.setName('Ignored files')
			.setHeading();

		containerEl.createEl('p', {
			text: 'The plugin automatically ignores hidden files, .obsidian, .git, node_modules, and .md, .canvas, .base files.',
			cls: 'setting-item-description',
		});
	}
}
