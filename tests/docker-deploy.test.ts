import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("docker-compose.yml pulls GHCR image and mounts required volumes", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");

  assert.match(compose, /ghcr\.io\/crearec\/crea-video-downloader/);
  assert.match(compose, /IMAGE_TAG/);
  assert.match(compose, /DOWNLOAD_DIR/);
  assert.match(compose, /\.\/config\/settings\.json:\/app\/config\/settings\.json/);
  assert.match(compose, /\.\/data:\/app\/data/);
  assert.match(compose, /\$\{DOWNLOAD_DIR\}:\/downloads/);
  assert.doesNotMatch(compose, /^\s*build:/m);
});

test("CI/CD workflow publishes to GHCR and deploys over SSH", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci-cd.yml"), "utf8");

  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /ghcr\.io\/crearec\/crea-video-downloader/);
  assert.match(workflow, /docker compose pull/);
  assert.match(workflow, /docker compose up -d/);
  assert.match(workflow, /docker-compose\.yml/);
  assert.doesNotMatch(workflow, /scripts\/deploy\.sh/);
});
