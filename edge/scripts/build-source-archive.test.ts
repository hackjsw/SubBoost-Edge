import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchive, collectSourceFiles, isAllowedSourcePath } from "./build-source-archive.mjs";

const temporaryRoots: string[] = [];

function writeFixture(root: string, relativePath: string, content: string) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepository(options: { dirtyProduct?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "subboost-source-archive-"));
  temporaryRoots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "archive-test@example.invalid");
  git(root, "config", "user.name", "Archive Test");

  const trackedFiles = {
    ".agents/skill.md": "agent-only\n",
    ".codex/config.toml": "private = true\n",
    ".gitignore": [
      "edge/.dev.vars",
      "edge/public/subboost-edge-source.tar.gz*",
      "local/src/generated/",
      "",
    ].join("\n"),
    ".trellis/workspace/journal.md": "private journal\n",
    "LICENSE": "license\n",
    "edge/public/logo.svg": "<svg />\n",
    "edge/worker/index.ts": "export const version = 1;\n",
    "local/scripts/clean-next.cjs": "module.exports = {};\n",
    "package-lock.json": "{}\n",
    "package.json": "{}\n",
    "packages/core/src/index.ts": "export const core = true;\n",
    "private-note.txt": "not product source\n",
    "scripts/tool.cjs": "module.exports = {};\n",
  };
  for (const [relativePath, content] of Object.entries(trackedFiles)) writeFixture(root, relativePath, content);
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "fixture");

  if (options.dirtyProduct !== false) {
    writeFixture(root, "edge/worker/index.ts", "export const version = 2;\n");
    writeFixture(root, "edge/worker/new-source.ts", "export const untracked = true;\n");
  }
  writeFixture(root, "edge/.dev.vars", "SECRET=value\n");
  writeFixture(root, "local/src/generated/client.js", "generated\n");
  writeFixture(root, ".trellis/runtime/session.json", "{}\n");
  writeFixture(root, "scratch.txt", "unrelated\n");
  return root;
}

function readTarEntries(archive: Buffer) {
  const tar = gunzipSync(archive);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const textField = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = textField(0, 100);
    const prefix = textField(345, 155);
    const size = Number.parseInt(textField(124, 12).trim() || "0", 8);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + 512;
    entries.set(relativePath, tar.subarray(contentStart, contentStart + size));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("Edge source archive", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("archives only allowlisted source and records deterministic revision digests", async () => {
    const root = createRepository();
    const commit = git(root, "rev-parse", "HEAD");
    const archivePath = path.join(root, "edge/public/subboost-edge-source.tar.gz");
    const files = await collectSourceFiles(root);
    const relativePaths = files.map((file) => file.relativePath);

    expect(relativePaths).not.toContain("subboost-edge-source/edge/worker/new-source.ts");
    expect(relativePaths).not.toEqual(
      expect.arrayContaining([
        "subboost-edge-source/.agents/skill.md",
        "subboost-edge-source/.codex/config.toml",
        "subboost-edge-source/.trellis/workspace/journal.md",
        "subboost-edge-source/local/src/generated/client.js",
        "subboost-edge-source/private-note.txt",
        "subboost-edge-source/scratch.txt",
      ]),
    );

    const first = await buildArchive({ archivePath, repositoryRoot: root });
    const firstArchive = readFileSync(archivePath);
    const entries = readTarEntries(firstArchive);
    const sourceInfo = entries.get("subboost-edge-source/SOURCE_INFO.txt")?.toString("utf8");

    expect(first.commit).toBe(commit);
    expect(first.dirty).toBe(true);
    expect(sourceInfo).toContain(`Source commit: ${commit}`);
    expect(sourceInfo).toContain("Source state: dirty");
    expect(sourceInfo).toContain(`Source tree SHA-256: ${first.sourceDigest}`);
    expect(sourceInfo).toContain("Archive SHA-256: see subboost-edge-source.tar.gz.sha256");
    expect(entries.get("subboost-edge-source/edge/worker/index.ts")?.toString("utf8")).toContain("version = 2");
    expect(entries.has("subboost-edge-source/edge/worker/new-source.ts")).toBe(false);
    expect([...entries.keys()].some((name) => /\/(?:\.trellis|\.agents|\.codex|generated)\//.test(name))).toBe(false);

    const expectedDigest = createHash("sha256").update(firstArchive).digest("hex");
    expect(first.archiveDigest).toBe(expectedDigest);
    expect(readFileSync(`${archivePath}.sha256`, "utf8")).toBe(
      `${expectedDigest}  subboost-edge-source.tar.gz\n`,
    );

    const second = await buildArchive({ archivePath, repositoryRoot: root });
    expect(second.archiveDigest).toBe(first.archiveDigest);
    expect(readFileSync(archivePath)).toEqual(firstArchive);
  });

  it("rejects traversal and nested private paths before filesystem resolution", () => {
    for (const candidate of [
      "edge/../secret.txt",
      "local/foo/../../secret.txt",
      "edge\\..\\secret.txt",
      "packages/../.trellis/secret.txt",
      "packages/.agents/secret.txt",
      "./edge/worker/../secret.ts",
    ]) {
      expect(isAllowedSourcePath(candidate)).toBe(false);
    }
  });

  it("fails closed when Git metadata is unavailable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "subboost-source-no-git-"));
    temporaryRoots.push(root);
    await expect(
      buildArchive({ archivePath: path.join(root, "edge/public/subboost-edge-source.tar.gz"), repositoryRoot: root }),
    ).rejects.toThrow("Git metadata is required");
  });

  it("does not mark excluded tooling and scratch files as source changes", async () => {
    const root = createRepository({ dirtyProduct: false });
    const result = await buildArchive({
      archivePath: path.join(root, "edge/public/subboost-edge-source.tar.gz"),
      repositoryRoot: root,
    });

    expect(result.dirty).toBe(false);
  });
});
