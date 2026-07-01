import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("systemd unit template exposes deploy placeholders", async () => {
  const unitPath = path.join(repoRoot, "deploy", "telegram-video-downloader.service");
  const unit = await readFile(unitPath, "utf8");

  assert.match(unit, /__USER__/);
  assert.match(unit, /__APP_DIR__/);
  assert.match(unit, /__DOWNLOAD_DIR__/);
  assert.doesNotMatch(unit, /\/opt\/telegram-video-downloader/);
});

test("deploy-remote.sh substitutes systemd template placeholders", async () => {
  const remotePath = path.join(repoRoot, "scripts", "deploy-remote.sh");
  const remote = await readFile(remotePath, "utf8");

  assert.match(remote, /deploy\/telegram-video-downloader\.service/);
  assert.match(remote, /s#__USER__#/);
  assert.match(remote, /s#__APP_DIR__#/);
  assert.match(remote, /s#__DOWNLOAD_DIR__#/);
});

test("deploy-remote.sh probes passwordless sudo via systemctl, not true", async () => {
  const remotePath = path.join(repoRoot, "scripts", "deploy-remote.sh");
  const remote = await readFile(remotePath, "utf8");

  assert.match(remote, /sudo_probe\(\)/);
  assert.match(remote, /sudo -n systemctl --version/);
  assert.doesNotMatch(remote, /\bsudo -n true\b/);
});
