/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023-2024 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import * as vscode from 'vscode';
import * as which from 'which';
import * as positron from 'positron';
import * as crypto from 'crypto';

import { RInstallation, RMetadataExtra, getRHomePath } from './r-installation';
import { LOGGER } from './extension';
import { EXTENSION_ROOT_DIR, MINIMUM_R_VERSION } from './constants';

// We don't give this a type so it's compatible with both the VS Code
// and the LSP types
export const R_DOCUMENT_SELECTORS = [
	{ language: 'r', scheme: 'untitled' },
	{ language: 'r', scheme: 'inmemory' },  // Console
	{ language: 'r', pattern: '**/*.{r,R}' },
	{ language: 'r', pattern: '**/*.{rprofile,Rprofile}' },
	{ language: 'r', pattern: '**/*.{qmd,Qmd}' },
	{ language: 'r', pattern: '**/*.{rmd,Rmd}' },
];

/**
 * Enum represents the source from which an R binary was discovered.
 */
enum BinarySource {
	/* eslint-disable-next-line @typescript-eslint/naming-convention */
	HQ = 'HQ',
	adHoc = 'ad hoc location',
	registry = 'Windows registry',
	/* eslint-disable-next-line @typescript-eslint/naming-convention */
	PATH = 'PATH',
	user = 'user-specified directory'
}

/**
 * Discovers R language runtimes for Positron; implements
 * positron.LanguageRuntimeDiscoverer.
 *
 * @param context The extension context.
 */
export async function* rRuntimeDiscoverer(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
	let rInstallations: Array<RInstallation> = [];
	const binaries = new Map<string, BinarySource>();

	// look for R executables in the well-known place(s) for R installations on this OS
	const systemHqBinaries = discoverHQBinaries(rHeadquarters());
	for (const b of systemHqBinaries) {
		binaries.set(b, BinarySource.HQ);
	}

	// consult user-specified, HQ-like directories
	const userHqBinaries = discoverHQBinaries(userRHeadquarters());
	for (const b of userHqBinaries) {
		binaries.set(b, BinarySource.user);
	}

	// other conventional places we might find an R binary (or a symlink to one)
	const possibleBinaries = [
		'/usr/bin/R',
		'/usr/local/bin/R',
		'/opt/local/bin/R',
		'/opt/homebrew/bin/R'
	];
	const moreBinaries = possibleBinaries
		.filter(b => fs.existsSync(b))
		.map(b => fs.realpathSync(b));
	for (const b of moreBinaries) {
		if (!binaries.has(b)) {
			binaries.set(b, BinarySource.adHoc);
		}
	}

	// same as above but user-specified, ad hoc binaries
	const userPossibleBinaries = userRBinaries();
	const userMoreBinaries = userPossibleBinaries
		.filter(b => fs.existsSync(b))
		.map(b => fs.realpathSync(b));
	for (const b of userMoreBinaries) {
		if (!binaries.has(b)) {
			binaries.set(b, BinarySource.user);
		}
	}

	const registryBinaries = await discoverRegistryBinaries();
	for (const b of registryBinaries) {
		if (!binaries.has(b)) {
			binaries.set(b, BinarySource.registry);
		}
	}

	const pathBinary = await findRBinaryFromPATH();
	if (pathBinary && !binaries.has(pathBinary)) {
		binaries.set(pathBinary, BinarySource.PATH);
	}

	// make sure we include the "current" version of R, for some definition of "current"
	// we've probably already discovered it, but we still want to single it out, so that we mark
	// that particular R installation as the current one
	const curBin = await findCurrentRBinary();
	if (curBin) {
		rInstallations.push(new RInstallation(curBin, true));
		binaries.delete(curBin);
	}

	binaries.forEach((source, bin) => {
		rInstallations.push(new RInstallation(bin));
	});

	// TODO: possible location to tell the user why certain R installations are being omitted from
	// the interpreter drop-down and, in some cases, offer to help fix the situation:
	// * version < minimum R version supported by positron-r
	// * (macOS only) version is not orthogonal and is not the current version of R
	// * invalid R installation
	rInstallations = rInstallations
		.filter(r => {
			if (!r.valid) {
				LOGGER.info(`Filtering out ${r.binpath}: invalid R installation.`);
				return false;
			}
			return true;
		})
		.filter(r => {
			if (!(r.current || r.orthogonal)) {
				LOGGER.info(`Filtering out ${r.binpath}: not current and also not orthogonal.`);
				return false;
			}
			return true;
		})
		.filter(r => {
			if (!r.supported) {
				LOGGER.info(`Filtering out ${r.binpath}: version is < ${MINIMUM_R_VERSION}`);
				return false;
			}
			return true;
		});

	// FIXME? should I explicitly check that there is <= 1 R installation
	// marked as 'current'?

	rInstallations.sort((a, b) => {
		if (a.current || b.current) {
			// always put the current R version first
			return Number(b.current) - Number(a.current);
		}
		// otherwise, sort by version number, descending
		// break ties by architecture
		// (currently taking advantage of the fact that 'aarch64' > 'x86_64')
		return semver.compare(b.semVersion, a.semVersion) || a.arch.localeCompare(b.arch);
	});

	// For now, we recommend an R runtime for the workspace based on a set of
	// non-runtime-specific heuristics.
	// In the future, we will use more sophisticated heuristics, such as
	// checking an renv lockfile for a match against a system version of R.
	let recommendedForWorkspace = await shouldRecommendForWorkspace();

	for (const rInst of rInstallations) {
		// If we're recommending an R runtime, request immediate startup.
		const startupBehavior = recommendedForWorkspace ?
			positron.LanguageRuntimeStartupBehavior.Immediate :
			positron.LanguageRuntimeStartupBehavior.Implicit;
		// But immediate startup only applies to, at most, one R installation -- specifically, the
		// first element of rInstallations.
		recommendedForWorkspace = false;

		// If there is another R installation with the same version but different architecture,
		// we need to disambiguate the runtime name by appending the architecture.
		// For example, if x86_64 and arm64 versions of R 4.4.0 exist simultaneously.
		let needsArch = false;
		for (const otherRInst of rInstallations) {
			if (rInst.version === otherRInst.version && rInst.arch !== otherRInst.arch) {
				needsArch = true;
				break;
			}
		}

		const metadata = makeMetadata(rInst, startupBehavior, needsArch);

		// Create an adapter for the kernel to fulfill the LanguageRuntime interface.
		yield metadata;
	}
}

export async function makeMetadata(
	rInst: RInstallation,
	startupBehavior: positron.LanguageRuntimeStartupBehavior = positron.LanguageRuntimeStartupBehavior.Implicit,
	includeArch: boolean = false
): Promise<positron.LanguageRuntimeMetadata> {
	// Is the runtime path within the user's home directory?
	const homedir = os.homedir();
	const isUserInstallation = rInst.binpath.startsWith(homedir);

	// Create the runtime path.
	// TODO@softwarenerd - We will need to update this for Windows.
	const runtimePath = os.platform() !== 'win32' && isUserInstallation ?
		path.join('~', rInst.binpath.substring(homedir.length)) :
		rInst.binpath;

	// Does the runtime path have 'homebrew' as a component? (we assume that
	// it's a Homebrew installation if it does)
	const isHomebrewInstallation = rInst.binpath.includes('/homebrew/');

	const runtimeSource = isHomebrewInstallation ? 'Homebrew' :
		isUserInstallation ?
			'User' : 'System';

	// Short name shown to users (when disambiguating within a language)
	const runtimeShortName = includeArch ? `${rInst.version} (${rInst.arch})` : rInst.version;

	// Full name shown to users
	const runtimeName = `R ${runtimeShortName}`;

	// Get the version of this extension from package.json so we can pass it
	// to the adapter as the implementation version.
	const packageJson = require('../package.json');

	const rVersion = rInst.version;

	// Create a stable ID for the runtime based on the interpreter path and version.
	const digest = crypto.createHash('sha256');
	digest.update(rInst.binpath);
	digest.update(rVersion);
	const runtimeId = digest.digest('hex').substring(0, 32);

	// Save the R home path and binary path as extra data.
	// Also, whether this R installation is the "current" R version.
	const extraRuntimeData: RMetadataExtra = {
		homepath: rInst.homepath,
		binpath: rInst.binpath,
		current: rInst.current
	};

	const metadata: positron.LanguageRuntimeMetadata = {
		runtimeId,
		runtimeName,
		runtimeShortName,
		runtimePath,
		runtimeVersion: packageJson.version,
		runtimeSource,
		languageId: 'r',
		languageName: 'R',
		languageVersion: rVersion,
		base64EncodedIconSvg:
			fs.readFileSync(
				path.join(EXTENSION_ROOT_DIR, 'resources', 'branding', 'r-icon.svg')
			).toString('base64'),
		sessionLocation: positron.LanguageRuntimeSessionLocation.Workspace,
		startupBehavior,
		extraRuntimeData
	};

	return metadata;
}

// directory(ies) where this OS is known to keep its R installations
function rHeadquarters(): string[] {
	switch (process.platform) {
		case 'darwin':
			return [path.join('/Library', 'Frameworks', 'R.framework', 'Versions')];
		case 'linux':
			return [path.join('/opt', 'R')];
		case 'win32': {
			const paths = [
				path.join(process.env['ProgramW6432'] || 'C:\\Program Files', 'R')
			];
			if (process.env['LOCALAPPDATA']) {
				paths.push(path.join(process.env['LOCALAPPDATA'], 'Programs', 'R'));
			}
			return [...new Set(paths)];
		}
		default:
			throw new Error('Unsupported platform');
	}
}

// directory(ies) where this user keeps R installations
function userRHeadquarters(): string[] {
	const config = vscode.workspace.getConfiguration('positron.r');
	const userHqDirs = config.get<string[]>('customRootFolders');
	if (userHqDirs && userHqDirs.length > 0) {
		const formattedPaths = JSON.stringify(userHqDirs, null, 2);
		LOGGER.info(`User-specified directories to scan for R installations:\n${formattedPaths}`);
		return userHqDirs;
	} else {
		return [];
	}
}

// ad hoc binaries this user wants Positron to know about
function userRBinaries(): string[] {
	const config = vscode.workspace.getConfiguration('positron.r');
	const userBinaries = config.get<string[]>('customBinaries');
	if (userBinaries && userBinaries.length > 0) {
		const formattedPaths = JSON.stringify(userBinaries, null, 2);
		LOGGER.info(`User-specified R binaries:\n${formattedPaths}`);
		return userBinaries;
	} else {
		return [];
	}
}

function firstExisting(base: string, fragments: string[]): string {
	const potentialPaths = fragments.map(f => path.join(base, f));
	const existingPath = potentialPaths.find(p => fs.existsSync(p));
	return existingPath || '';
}

function discoverHQBinaries(hqDirs: string[]): string[] {
	const existingHqDirs = hqDirs.filter(dir => fs.existsSync(dir));
	if (existingHqDirs.length === 0) {
		return [];
	}

	const versionDirs = existingHqDirs
		.map(hqDir => fs.readdirSync(hqDir).map(file => path.join(hqDir, file)))
		// Windows: rig creates 'bin/', which is a directory of .bat files (at least, for now)
		// https://github.com/r-lib/rig/issues/189
		.map(listing => listing.filter(path => !path.endsWith('bin')))
		// macOS: 'Current' (uppercase 'C'), if it exists, is a symlink to an actual version
		// linux: 'current' (lowercase 'c'), if it exists, is a symlink to an actual version
		.map(listing => listing.filter(path => !path.toLowerCase().endsWith('current')));

	// On Windows:
	// In the case that both (1) and (2) exist we prefer (1).
	// (1) C:\Program Files\R\R-4.3.2\bin\x64\R.exe
	// (2) C:\Program Files\R\R-4.3.2\bin\R.exe
	// Because we require R >= 4.2, we don't need to consider bin\i386\R.exe.
	const binaries = versionDirs
		.map(vd => vd.map(x => firstExisting(x, binFragments())))
		.flat()
		// macOS: By default, the CRAN installer deletes previous R installations, but sometimes
		// it doesn't do a thorough job of it and a nearly-empty version directory lingers on.
		.filter(b => fs.existsSync(b));
	return binaries;
}

function binFragments(): string[] {
	switch (process.platform) {
		case 'darwin':
			return [path.join('Resources', 'bin', 'R')];
		case 'linux':
			return [path.join('bin', 'R')];
		case 'win32':
			return [
				path.join('bin', 'x64', 'R.exe'),
				path.join('bin', 'R.exe')
			];
		default:
			throw new Error('Unsupported platform');
	}
}

/**
 * Generates all possible R versions that we might find recorded in the Windows registry.
 * Sort of.
 * Only considers the major version of Positron's current minimum R version and that major
 * version plus one.
 * Naively tacks " Pre-release" onto each version numbers, because that's how r-devel shows up.
*/
function generateVersions(): string[] {
	const minimumSupportedVersion = semver.coerce(MINIMUM_R_VERSION)!;
	const major = minimumSupportedVersion.major;
	const minor = minimumSupportedVersion.minor;
	const patch = minimumSupportedVersion.patch;

	const versions: string[] = [];
	for (let x = major; x <= major + 1; x++) {
		for (let y = (x === major ? minor : 0); y <= 9; y++) {
			for (let z = (x === major && y === minor ? patch : 0); z <= 9; z++) {
				versions.push(`${x}.${y}.${z}`);
				versions.push(`${x}.${y}.${z} Pre-release`);
			}
		}
	}

	return versions;
}

async function discoverRegistryBinaries(): Promise<string[]> {
	if (os.platform() !== 'win32') {
		LOGGER.info('Skipping registry check on non-Windows platform');
		return [];
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	const Registry = await import('@vscode/windows-registry');

	const hives: any[] = ['HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE'];
	// R's install path is written to a WOW (Windows on Windows) node when e.g. an x86 build of
	// R is installed on an ARM version of Windows.
	const wows = ['', 'WOW6432Node'];

	// The @vscode/windows-registry module is so minimalistic that it can't list the registry.
	// Therefore we explicitly generate the R versions that might be there and check for each one.
	const versions = generateVersions();

	const discoveredKeys: string[] = [];

	for (const hive of hives) {
		for (const wow of wows) {
			for (const version of versions) {
				const R64_KEY: string = `SOFTWARE\\${wow ? wow + '\\' : ''}R-core\\R64\\${version}`;
				try {
					const key = Registry.GetStringRegKey(hive, R64_KEY, 'InstallPath');
					if (key) {
						LOGGER.info(`Registry key ${hive}\\${R64_KEY}\\InstallPath reports an R installation at ${key}`);
						discoveredKeys.push(key);
					}
				} catch { }
			}
		}
	}

	const binPaths = discoveredKeys
		.map(installPath => firstExisting(installPath, binFragments()))
		.filter(binPath => binPath !== undefined);

	return binPaths;
}

let cachedRBinary: string | undefined;

export async function findCurrentRBinary(): Promise<string | undefined> {
	if (cachedRBinary !== undefined) {
		return cachedRBinary;
	}

	if (os.platform() === 'win32') {
		const registryBinary = await findCurrentRBinaryFromRegistry();
		if (registryBinary) {
			cachedRBinary = registryBinary;
			return registryBinary;
		}
	}

	// TODO: for macOS, this should arguably be whatever
	// /Library/Frameworks/R.framework/Versions/Current/ resolves to
	// that would remove overlap between `findCurrentBinary()` and `findRBinaryFromPATH()`

	cachedRBinary = await findRBinaryFromPATH();
	return cachedRBinary;
}

let cachedRBinaryFromPATH: string | undefined;

async function findRBinaryFromPATH(): Promise<string | undefined> {
	if (cachedRBinaryFromPATH !== undefined) {
		return cachedRBinaryFromPATH;
	}

	const whichR = await which('R', { nothrow: true }) as string;
	if (whichR) {
		LOGGER.info(`Possibly found R on PATH: ${whichR}.`);
		if (os.platform() === 'win32') {
			cachedRBinaryFromPATH = await findRBinaryFromPATHWindows(whichR);
		} else {
			cachedRBinaryFromPATH = await findRBinaryFromPATHNotWindows(whichR);
		}
	} else {
		cachedRBinaryFromPATH = undefined;
	}

	return cachedRBinaryFromPATH;
}

export async function findRBinaryFromPATHWindows(whichR: string): Promise<string | undefined> {
	// The CRAN Windows installer does NOT put R on the PATH.
	// If we are here, it is because the user has arranged it so.
	const ext = path.extname(whichR).toLowerCase();
	if (ext !== '.exe') {
		// rig can put put something on the PATH that results in whichR being 'a/path/to/R.bat'
		// but we aren't going to handle that.
		LOGGER.info(`Unsupported extension: ${ext}.`);
		return undefined;
	}

	// Overall idea: a discovered binpath --> homepath --> our preferred binpath
	// This might just be a no-op.
	// But if the input binpath is this:
	// "C:\Program Files\R\R-4.3.2\bin\R.exe"
	// we want to convert it to this, if it exists:
	// "C:\Program Files\R\R-4.3.2\bin\x64\R.exe"
	// It typically does exist for x86_64 R installations.
	// It will not exist for arm64 R installations.
	const whichRHome = getRHomePath(whichR);
	if (!whichRHome) {
		LOGGER.info(`Failed to get R home path from ${whichR}.`);
		return undefined;
	}
	const binpathNormalized = firstExisting(whichRHome, binFragments());
	if (binpathNormalized) {
		LOGGER.info(`Resolved R binary at ${binpathNormalized}.`);
		return binpathNormalized;
	} else {
		LOGGER.info(`Can't find R binary within ${whichRHome}.`);
		return undefined;
	}
}

async function findRBinaryFromPATHNotWindows(whichR: string): Promise<string | undefined> {
	const whichRCanonical = fs.realpathSync(whichR);
	LOGGER.info(`Resolved R binary at ${whichRCanonical}`);
	return whichRCanonical;
}

async function findCurrentRBinaryFromRegistry(): Promise<string | undefined> {
	if (os.platform() !== 'win32') {
		LOGGER.info('Skipping registry check on non-Windows platform');
		return undefined;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	const Registry = await import('@vscode/windows-registry');

	const hives: any[] = ['HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE'];
	const wows = ['', 'WOW6432Node'];

	let installPath = undefined;

	for (const hive of hives) {
		for (const wow of wows) {
			const R64_KEY: string = `SOFTWARE\\${wow ? wow + '\\' : ''}R-core\\R64`;
			try {
				const key = Registry.GetStringRegKey(hive, R64_KEY, 'InstallPath');
				if (key) {
					installPath = key;
					LOGGER.info(`Registry key ${hive}\\${R64_KEY}\\InstallPath reports the current R installation is at ${key}`);
					break;
				}
			} catch { }
		}
	}

	if (installPath === undefined) {
		LOGGER.info('Cannot determine current version of R from the registry.');
		return undefined;
	}

	const binPath = firstExisting(installPath, binFragments());
	if (!binPath) {
		return undefined;
	}
	LOGGER.info(`Identified the current R binary: ${binPath}`);

	return binPath;
}

// Should we recommend an R runtime for the workspace?
async function shouldRecommendForWorkspace(): Promise<boolean> {
	// Check if the workspace contains R-related files.
	const globs = [
		'**/*.R',
		'**/*.Rmd',
		'.Rprofile',
		'renv.lock',
		'.Rbuildignore',
		'.Renviron',
		'*.Rproj'
	];
	// Convert to the glob format used by vscode.workspace.findFiles.
	const glob = `{${globs.join(',')}}`;
	if (await hasFiles(glob)) {
		return true;
	}

	// Check if the workspace is empty and the user is an RStudio user.
	if (!(await hasFiles('**/*')) && isRStudioUser()) {
		return true;
	}

	return false;
}

// Check if the current workspace contains files matching a glob pattern.
async function hasFiles(glob: string): Promise<boolean> {
	// Exclude node_modules for performance reasons
	return (await vscode.workspace.findFiles(glob, '**/node_modules/**', 1)).length > 0;
}

/**
 * Attempts to heuristically determine if the user is an RStudio user by
 * checking for recently modified files in RStudio's state directory.
 *
 * @returns true if the user is an RStudio user, false otherwise
 */
function isRStudioUser(): boolean {
	try {
		const filenames = fs.readdirSync(rstudioStateFolderPath());
		const today = new Date();
		const thirtyDaysAgo = new Date(new Date().setDate(today.getDate() - 30));
		const isRecentlyModified = filenames.some(file => {
			const stats = fs.statSync(rstudioStateFolderPath(file));
			return stats.mtime > thirtyDaysAgo;
		});
		return isRecentlyModified;
	} catch { }
	return false;
}

/**
 * Returns the path to RStudio's state folder directory. Currently checks only the default for each
 * OS. A more earnest effort would require fully implementing the logic in RStudio's `userDataDir()`
 * functions (there are implementations in both C++ and Typescript). That would add logic to
 * check the variables RSTUDIO_DATA_HOME and XDG_DATA_HOME.
 *
 * @param pathToAppend The path to append, if any
 * @returns The path to RStudio's state folder directory.
 */
function rstudioStateFolderPath(pathToAppend = ''): string {
	let newPath: string;
	switch (process.platform) {
		case 'darwin':
		case 'linux':
			newPath = path.join(process.env.HOME!, '.local/share/rstudio', pathToAppend);
			break;
		case 'win32':
			newPath = path.join(process.env.LOCALAPPDATA!, 'RStudio', pathToAppend);
			break;
		default:
			throw new Error('Unsupported platform');
	}
	return newPath;
}
