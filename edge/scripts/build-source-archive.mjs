import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const UPSTREAM_COMMIT = "ebc40a202adeaca25c88ca3bbbf085412f6e08f5";
const archiveName = "subboost-edge-source.tar.gz";
const sourcePrefix = "subboost-edge-source/";
const edgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepositoryRoot = path.resolve(edgeRoot, "..");
const defaultArchivePath = path.join(edgeRoot, "public", archiveName);

const allowedRootFiles = new Set([
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "README-CN.md",
  "README.md",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.core.config.ts",
]);
const allowedDirectoryPrefixes = ["docs/", "edge/", "local/", "packages/", "scripts/"];
const excludedDirectoryNames = new Set([
  ".git",
  ".trellis",
  ".agents",
  ".codex",
  ".next",
  ".wrangler",
  ".turbo",
  ".codegraph",
  "__pycache__",
  "node_modules",
  "out",
  "dist",
  "coverage",
  ".tmp",
  "tmp",
  "data",
  "generated",
]);

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== "string") return "";
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isAllowedSourcePath(candidate) {
  const relativePath = normalizeRelativePath(candidate);
  if (!relativePath || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)) return false;

  const segments = relativePath.split("/");
  // Reject traversal segments before path.join can normalize them away.
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (segments.some((segment) => excludedDirectoryNames.has(segment) || segment.startsWith(".next.bak-"))) {
    return false;
  }
  if (!allowedRootFiles.has(relativePath) && !allowedDirectoryPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }

  const name = path.posix.basename(relativePath);
  if (name === archiveName || name.startsWith(`${archiveName}.`)) return false;
  if (name === "next-env.d.ts" || name === ".DS_Store" || name === ".npmrc") return false;
  if (name.endsWith(".tsbuildinfo") || name.endsWith(".pem") || name.endsWith(".pyc")) return false;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return false;
  if (name === ".dev.vars" || (name.startsWith(".dev.vars.") && name !== ".dev.vars.example")) return false;
  return !/^(npm|yarn)-debug\.log/.test(name) && name !== "yarn-error.log";
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`Git metadata is required to build the Edge source archive: ${detail}`);
  }
  return result.stdout;
}

function getGitState(repositoryRoot) {
  const commit = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  const dirty =
    runGit(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
      "--",
      ...allowedRootFiles,
      ...allowedDirectoryPrefixes.map((prefix) => prefix.slice(0, -1)),
    ]).length > 0;
  return { commit, dirty };
}

export async function collectSourceFiles(repositoryRoot = defaultRepositoryRoot) {
  // Only committed/indexed paths are eligible. An arbitrary untracked file in
  // an allowlisted directory must not become a release artifact by accident.
  const relativePaths = runGit(repositoryRoot, ["ls-files", "-z", "--cached"])
    .split("\0")
    .filter(isAllowedSourcePath)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const files = [];

  for (const relativePath of relativePaths) {
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    let fileStat;
    try {
      fileStat = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Source archive does not accept symbolic links: ${relativePath}`);
    }
    if (fileStat.isFile()) files.push({ absolutePath, relativePath: `${sourcePrefix}${relativePath}` });
  }

  return files;
}

function writeString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`Tar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  writeString(buffer, offset, length, encoded);
}

function splitTarPath(relativePath) {
  if (Buffer.byteLength(relativePath) <= 100) return { name: relativePath, prefix: "" };

  for (let index = relativePath.lastIndexOf("/"); index > 0; index = relativePath.lastIndexOf("/", index - 1)) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }

  throw new Error(`Path cannot be represented in a ustar archive: ${relativePath}`);
}

function createTarEntry(relativePath, content, mode = 0o644) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(relativePath);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  writeString(header, 148, 8, `${checksum}\0 `);

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return [header, content, padding];
}

function hashSourceEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(String(entry.mode));
    hash.update("\0");
    hash.update(String(entry.content.length));
    hash.update("\0");
    hash.update(entry.content);
  }
  return hash.digest("hex");
}

async function writeAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function buildArchive(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || defaultRepositoryRoot);
  const outputPath = path.resolve(options.archivePath || defaultArchivePath);
  const sidecarPath = `${outputPath}.sha256`;
  const { commit, dirty } = getGitState(repositoryRoot);
  const files = await collectSourceFiles(repositoryRoot);
  const entries = await Promise.all(
    files.map(async (file) => ({
      ...file,
      content: await readFile(file.absolutePath),
      mode: /\.(?:sh|cjs)$/.test(file.relativePath) ? 0o755 : 0o644,
    })),
  );
  const sourceDigest = hashSourceEntries(entries);
  const sourceInfo = Buffer.from(
    [
      "EdgeSub complete corresponding source",
      "",
      "License: AGPL-3.0-only",
      "Upstream: https://github.com/SubBoost/subboost",
      `Upstream commit: ${UPSTREAM_COMMIT}`,
      `Source commit: ${commit}`,
      `Source state: ${dirty ? "dirty" : "clean"}`,
      `Source tree SHA-256: ${sourceDigest}`,
      `Archive SHA-256: see ${path.basename(sidecarPath)}`,
      "",
      "Build: npm ci && npm run edge:build",
      "Deploy: npm run edge:deploy",
      "",
    ].join("\n"),
    "utf8",
  );
  const chunks = createTarEntry(`${sourcePrefix}SOURCE_INFO.txt`, sourceInfo);

  for (const entry of entries) {
    chunks.push(...createTarEntry(entry.relativePath, entry.content, entry.mode));
  }
  chunks.push(Buffer.alloc(1024));

  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  await writeAtomic(outputPath, archive);
  await writeAtomic(sidecarPath, `${archiveDigest}  ${path.basename(outputPath)}\n`);
  console.log(
    `Created ${path.relative(repositoryRoot, outputPath).replaceAll(path.sep, "/")} with ${entries.length + 1} source files (${archiveDigest})`,
  );
  return { archiveDigest, archivePath: outputPath, commit, dirty, sidecarPath, sourceDigest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildArchive();
}
