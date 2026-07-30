'use strict';

// Self-update and rollback: download a GitHub Release tgz and install it globally.
// Requires `gh` (GitHub CLI) to be installed and authenticated.

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO = 'xhqing/CC-BRIDGE';
const TGZ_PATTERN = /^cc-bridge-\d+\.\d+\.\d+\.tgz$/;

// Semver-ish comparison: compares arrays of numeric segments [major, minor, patch].
function parseVersion(v) {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function getCurrentVersion() {
  const raw = require('../package.json').version;
  return { raw, parsed: parseVersion(raw) };
}

// Verify `gh` is installed and authenticated.
function ensureGhReady() {
  try { execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 5000 }); }
  catch { throw new Error('gh (GitHub CLI) is not installed. Install it from https://cli.github.com/'); }

  try { execSync('gh auth status', { stdio: 'ignore', timeout: 10000 }); }
  catch { throw new Error('gh is not authenticated. Run: gh auth login'); }
}

// Fetch release metadata for a given tag via `gh`.
// Returns { tagName, version, assetName } or throws.
function getRelease(tagName) {
  const raw = execFileSync('gh', [
    'release', 'view', tagName, '--repo', REPO,
    '--json', 'tagName,assets',
    '--jq', '{tagName: .tagName, assets: [.assets[].name]}',
  ], { encoding: 'utf-8', timeout: 30000 });

  const info = JSON.parse(raw.trim());
  const ver = parseVersion(info.tagName);
  if (!ver) throw new Error(`cannot parse version from tag "${info.tagName}"`);

  const asset = info.assets.find((a) => TGZ_PATTERN.test(a));
  if (!asset) throw new Error(`no cc-bridge-*.tgz asset found in release ${info.tagName}`);

  return { tagName: info.tagName, version: ver, assetName: asset };
}

// Fetch the latest release metadata via `gh`.
function getLatestRelease() {
  const raw = execFileSync('gh', [
    'release', 'view', '--repo', REPO,
    '--json', 'tagName,assets',
    '--jq', '{tagName: .tagName, assets: [.assets[].name]}',
  ], { encoding: 'utf-8', timeout: 30000 });

  const info = JSON.parse(raw.trim());
  const ver = parseVersion(info.tagName);
  if (!ver) throw new Error(`cannot parse version from tag "${info.tagName}"`);

  const asset = info.assets.find((a) => TGZ_PATTERN.test(a));
  if (!asset) throw new Error(`no cc-bridge-*.tgz asset found in release ${info.tagName}`);

  return { tagName: info.tagName, version: ver, assetName: asset };
}

// List all releases sorted by version descending. Returns [{ tagName, version }].
function listReleases() {
  const raw = execFileSync('gh', [
    'release', 'list', '--repo', REPO,
    '--json', 'tagName',
    '--limit', '100',
  ], { encoding: 'utf-8', timeout: 30000 });

  const releases = JSON.parse(raw.trim())
    .map((r) => ({ tagName: r.tagName, version: parseVersion(r.tagName) }))
    .filter((r) => r.version);

  releases.sort((a, b) => cmpVersion(b.version, a.version)); // descending
  return releases;
}

// Download a tgz from a release and install it globally.
function downloadAndInstall(release) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-update-'));
  const tgzPath = path.join(tmpDir, release.assetName);

  console.log(`[bridge] downloading ${release.assetName}…`);
  try {
    execFileSync('gh', [
      'release', 'download', release.tagName,
      '--repo', REPO,
      '--pattern', release.assetName,
      '--dir', tmpDir,
      '--clobber',
    ], { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    throw new Error(`download failed: ${e.message}`);
  }

  console.log('[bridge] installing globally…');
  try {
    execFileSync('npm', ['install', '-g', tgzPath], { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    throw new Error(`npm install failed: ${e.message}`);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Self-update to the latest GitHub Release.
 */
function runUpdate() {
  ensureGhReady();

  console.log('[bridge] checking for updates…');
  const current = getCurrentVersion();
  let latest;
  try { latest = getLatestRelease(); }
  catch (e) { throw new Error(`failed to fetch latest release: ${e.message}`); }

  console.log(`[bridge] current version : ${current.raw}`);
  console.log(`[bridge] latest version  : ${latest.tagName.replace(/^v/, '')}`);

  if (current.parsed && cmpVersion(current.parsed, latest.version) >= 0) {
    console.log('[bridge] already up-to-date.');
    return;
  }

  downloadAndInstall(latest);

  console.log('');
  console.log(`[bridge] updated to ${latest.tagName.replace(/^v/, '')} successfully!`);
  console.log('[bridge] run `cc-bridge restart` to apply the update to any running daemon.');
}

/**
 * Rollback to a specific version or the previous version.
 * @param {string} [targetVersion] - Version to rollback to (e.g. "2.3.0"). If omitted, rollback to the previous release.
 */
function runRollback(targetVersion) {
  ensureGhReady();

  const current = getCurrentVersion();
  console.log(`[bridge] current version : ${current.raw}`);

  let releases;
  try { releases = listReleases(); }
  catch (e) { throw new Error(`failed to list releases: ${e.message}`); }

  let target;

  if (targetVersion) {
    // Rollback to a specific version
    const targetParsed = parseVersion(targetVersion);
    if (!targetParsed) {
      throw new Error(`invalid version format "${targetVersion}". Expected format: X.Y.Z`);
    }
    if (current.parsed && cmpVersion(current.parsed, targetParsed) === 0) {
      throw new Error(`already at version ${targetVersion}, nothing to rollback to.`);
    }
    target = releases.find((r) => cmpVersion(r.version, targetParsed) === 0);
    if (!target) {
      const available = releases.map((r) => r.tagName.replace(/^v/, '')).join(', ');
      throw new Error(`version ${targetVersion} not found in releases. Available: ${available}`);
    }
  } else {
    // Rollback to the previous version (original behavior)
    if (releases.length < 2) {
      throw new Error('no older release available to rollback to.');
    }

    // Find the current version in the list, then pick the next one (older).
    const idx = releases.findIndex((r) => current.parsed && cmpVersion(r.version, current.parsed) === 0);
    if (idx === -1) {
      // Current version not found in releases (e.g. local dev build); rollback to the latest release.
      target = releases[0];
    } else if (idx + 1 < releases.length) {
      target = releases[idx + 1];
    } else {
      throw new Error('already at the oldest release, nothing to rollback to.');
    }
  }

  const targetVer = target.tagName.replace(/^v/, '');
  console.log(`[bridge] rolling back to : ${targetVer}`);

  let release;
  try { release = getRelease(target.tagName); }
  catch (e) { throw new Error(`failed to fetch release ${target.tagName}: ${e.message}`); }

  downloadAndInstall(release);

  console.log('');
  console.log(`[bridge] rolled back to ${targetVer} successfully!`);
  console.log('[bridge] run `cc-bridge restart` to apply the rollback to any running daemon.');
}

module.exports = { runUpdate, runRollback, getLatestRelease, getCurrentVersion };
