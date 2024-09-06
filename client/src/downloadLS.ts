import { accessSync, chmod, chmodSync, existsSync, mkdirSync, rmSync } from 'fs';
import axios, { isCancel, AxiosError, all } from 'axios';
import { platform } from "process";
import * as path from "node:path";
import { constants, readdir } from 'fs/promises';
import { MessageOptions, Progress, ProgressLocation, ProgressOptions, window } from 'vscode';
import { DownloaderHelper } from 'node-downloader-helper';
import { execFileSync } from 'child_process';

// Information about the language server
const LS_FOLDER = path.join(__dirname, "../../server/");

// Github variables
const GITHUB_OWNER: string = `Elkozel`;
const GITHUB_REPOSITORY: string = `Meerkat`;

export async function initializeLS(): Promise<LanguageServer> {
	let opt: ProgressOptions = {
		location: ProgressLocation.Window,
		title: "Initializing language server"
	}
	await window.withProgress(opt, async (t, token) => {
		t.report({ message: "Fetching remote servers" })
		let allServers = await fetchServers();

		// Check if there is a language server downloaded, otherwise download one
		let localServers = await getLocalServers();
		if (localServers.length == 0) {
			await getLatest(allServers).download()
		}

		t.report({ message: "Checking update" })
		await checkLSUpdate()
	})

	return getLatest(await getLocalServers());
}

export async function getLocalServers(): Promise<LanguageServer[]> {
	// Create the folder for the language servers if it does not exist
	if (!existsSync(LS_FOLDER))
		console.log(mkdirSync(LS_FOLDER, { recursive: true }));

	// Get all folders
	let allFolders = (await readdir(LS_FOLDER, { withFileTypes: true }))
		.filter(file => file.isDirectory());

	// Generate a list of language servers
	let languageServers = allFolders
		.map(folder => new LanguageServer(folder.name))
		.filter(ls => ls.check());

	return languageServers;
}

export async function fetchServers(): Promise<LanguageServer[]> {

	let response = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/releases`, {
		headers: {
			'X-GitHub-Api-Version': '2022-11-28',
			'Accept': 'application/vnd.github+json'
		}
	})
	// let response = await octokit.request('GET /repos/{owner}/{repo}/releases', {
	// 	owner: GITHUB_OWNER,
	// 	repo: GITHUB_REPOSITORY,
	// 	headers: {
	// 		'X-GitHub-Api-Version': '2022-11-28'
	// 	}
	// });

	if (response.status !== 200)
		throw new Error(`Could not fetch releases, server answered with status code ${response.status}`)

	let releases = response.data
	let servers = releases.filter(r => r.tag_name.startsWith("v"))
		.map(r => new LanguageServer(r.tag_name.substring(1)))
		.filter((s: LanguageServer) => s.canRun);

	return servers;
}

export async function checkLSUpdate() {
	// Fetch all servers, which the client can run
	let allServers = await fetchServers();

	// Check if the latest version is already downloaded
	if (getLatest(allServers).check())
		// Then the latest is installed and used
		return;

	// Otherwise, propose to the user for the latest to be downloaded
	let currentVersion = getLatest(allServers.filter(s => s.check()));
	let latestVersion = getLatest(allServers);
	let promptUpdate = await window.showInformationMessage(`Language server can be updated (v${currentVersion.version} -> v${latestVersion.version})`, "Update", "Not this time")

	// If the user closes the window or answers with "No", there is not much we can do
	if (!promptUpdate || promptUpdate === "Not this time")
		return;

	// Otherwise, start the update
	await latestVersion.download();
	await currentVersion.delete();

	// Notify the user
	window.showInformationMessage(`Language server successfully updated to version ${latestVersion.version}`);

}

/**
 * Returns the latest version from a list of servers
 * @param servers a list of available servers
 * @returns the server with the highest version
 */
export function getLatest(servers: LanguageServer[]) {
	return servers.sort((l1, l2) => l1.version.localeCompare(l2.version)).at(-1);
}

class LanguageServer {
	/** The version of the language server */
	version: string;
	/** Whether the language server is already downloaded */
	downloaded: boolean;
	/** Download links for the language server */
	downloadLinks: Map<string, string>;

	constructor(version: string) {
		this.version = version;

		// For now, the platforms are hardcoded
		this.downloadLinks = new Map();
		this.downloadLinks.set("win32", `https://github.com/Elkozel/Meerkat/releases/download/v${this.version}/meerkat-ls.exe`);
		this.downloadLinks.set("linux", `https://github.com/Elkozel/Meerkat/releases/download/v${this.version}/meerkat-ls`);

		// Check whether the language server is available
		this.check();
	}

	/**
	 * Retrieve the download link for this platform
	 * @returns the link to download the language server (platform specific)
	 * @throws error if no download link is available for this platform
	 */
	get downloadLink(): string {
		// Verify platform is valid
		if (!this.downloadLinks.has(platform)) {
			throw new Error(`Cannot download language server for platform "${platform}" (Available platforms: ${this.downloadLinks.keys()})`)
		}

		// Return the platform-specific download link
		return this.downloadLinks.get(platform);
	}

	/**
	 * The filepath where the server is expected to be (if the server is not downloaded, the file should not exist)
	 */
	get filePath(): string {
		// Derive the filename based on the download link
		let fileName = path.basename(this.downloadLink);

		// Calculate the expected filepath for this version
		return path.join(LS_FOLDER, this.version, fileName)
	}

	/**
	 * Check if the language server can be run on the current platform
	 * @returns Returns true of the LS can be run
	 */
	get canRun(): boolean {
		return this.downloadLinks.has(platform);
	}

	/**
	 * Check if language server can be run
	 */
	check(): boolean {
		try {
			// Try to execute the file
			execFileSync(this.filePath.toString(), ["--version"])
			// Otherwise, the language server is present and executable
			this.downloaded = true;
		}
		catch (err) {
			// If there was an error, most probably the file was not there
			this.downloaded = false;
		}

		return this.downloaded;
	}

	/**
	 * Downloads the language server
	 * @param platform the specific platform, for which the LS to be downloaded
	 * @returns a DownloaderHelper object, which can be used to track the download
	 */
	async download(): Promise<void> {
		let opt: ProgressOptions = {
			location: ProgressLocation.Notification,
		}
		await window.withProgress(opt, async (p, token) => {

			// Verify platform is valid
			if (!this.downloadLinks.has(platform)) {
				throw new Error(`Cannot download language server for platform "${platform}" (Available platforms: ${this.downloadLinks.keys()})`)
			}

			let downloadLocation = path.join(LS_FOLDER, this.version)

			// Create the folder for the language server if it does not exist
			if (!existsSync(downloadLocation))
				console.log(mkdirSync(downloadLocation, { recursive: true }));

			// Download the language server
			const dh = new DownloaderHelper(this.downloadLinks.get(platform), downloadLocation, {
				override: true,
			});

			dh.on('start', () =>
				p.report({
					message: `Starting download (v${this.version})`,
				})
			);

			// Show the progress to the user
			dh.on('progress.throttled', (e) =>
				p.report({
					message: `Downloading language server v${this.version} (${e.progress}%)`,
				})
			);

			// Once done, show the user and change the file to be executable
			dh.on('end', (e) => {
				p.report({
					message: `Language server downloaded to ${this.filePath}`
				})
				chmodSync(this.filePath, 0x775);
			});

			// Start the download and wait
			await dh.start();
		});
	}

	async delete() {
		let opt: ProgressOptions = {
			location: ProgressLocation.Notification,
			title: "Deleting Language Server"
		}
		window.withProgress(opt, async (p, token) => {
			p.report({ message: `Deleting language server v${this.version}` })
			// Check if the server exists, otherwise return
			if (!this.check())
				return;

			// Remove the server
			rmSync(this.filePath, {
				force: true
			});

			// Remove the directory
			rmSync(path.dirname(this.filePath), {
				recursive: true,
				force: true
			});

			p.report({ message: `Language server v${this.version} deleted` })
		});

	}
}