import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("managed Node ignores ambient Node and caller config while preserving cwd, args and child PATH", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "managed-node-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, ".mise.toml"), '[tools]\nnode = "0.0.0"\n');
	writeFileSync(join(cwd, "node"), "#!/bin/sh\nexit 91\n");
	chmodSync(join(cwd, "node"), 0o755);
	const result = spawnSync(join(root, "scripts/node.sh"), [
		"-e",
		`const { execFileSync } = require("node:child_process");
console.log(JSON.stringify({ version: process.version, execPath: process.execPath,
cwd: process.cwd(), args: process.argv.slice(1),
child: execFileSync("node", ["--version"], { encoding: "utf8" }).trim() }));`,
		"argument with spaces",
	], { cwd, env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || String(result.error));
	const actual = JSON.parse(result.stdout);
	const version = readFileSync(join(root, ".mise.toml"), "utf8").match(/^node = "([^"]+)"/m)[1];
	assert.equal(actual.version, `v${version}`);
	assert.equal(actual.child, `v${version}`);
	assert.equal(actual.cwd, realpathSync(cwd));
	assert.deepEqual(actual.args, ["argument with spaces"]);
	const selected = spawnSync("mise", ["-C", root, "which", "node"], { encoding: "utf8" });
	assert.equal(selected.status, 0, selected.stderr);
	assert.equal(actual.execPath, selected.stdout.trim());
});
