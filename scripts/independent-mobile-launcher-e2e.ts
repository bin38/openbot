// Exercises real competing launcher processes, crashes, surviving children and exit diagnostics.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenBotLogger, teeLogLines } from "@openbot/logging";
import { z } from "zod";
import { acquireIndependentMobileLock, startIndependentMobileChild } from "./run-independent-mobile";

const self = fileURLToPath(import.meta.url);
const logger = createOpenBotLogger("independent-mobile-launcher-e2e");
const readySchema = z.object({ pid: z.int().positive(), childPid: z.int().positive().nullable() });

async function holder(): Promise<void> {
  const root = process.argv[3];
  if (!root) throw new Error("Fixture root is missing.");
  const ports = { signalPort: Number(process.argv[4]), healthPort: Number(process.argv[5]) };
  const lock = await acquireIndependentMobileLock(root, ports);
  let child: ChildProcess | null = null;
  if (process.argv[6] === "child") {
    child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    assert.ok(child.pid);
    lock.recordChild("tunnel", child.pid);
  }
  process.stdout.write(`READY ${JSON.stringify({ pid: process.pid, childPid: child?.pid ?? null })}\n`);
  await once(process.stdin, "data");
  if (child) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  lock.release();
  process.stdin.pause();
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function startHolder(root: string, ports: { signalPort: number; healthPort: number }, withChild = false) {
  const child = spawn(
    process.execPath,
    [self, "--holder", root, String(ports.signalPort), String(ports.healthPort), withChild ? "child" : "alone"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("exit", done);
  });
  let output = "";
  let errors = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  const ready = new Promise<z.infer<typeof readySchema>>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error("A fixture launcher did not become ready.")), 15_000);
    child.stdout?.on("data", () => {
      const line = output.split("\n").find((candidate) => candidate.startsWith("READY "));
      if (!line) return;
      clearTimeout(deadline);
      done(readySchema.parse(JSON.parse(line.slice(6))));
    });
    child.once("exit", () => {
      clearTimeout(deadline);
      fail(new Error(errors || "Fixture launcher exited."));
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      fail(error);
    });
  });
  return { child, exit, ready, errors: () => errors };
}

async function waitAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error("An owned fixture process did not stop.");
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}

async function main(): Promise<void> {
  const output = resolve(".openbot-build/independent-mobile-launcher-e2e");
  const root = await mkdtemp(join(tmpdir(), "openbot-mobile-launcher-"));
  const ports = { signalPort: await freePort(), healthPort: await freePort() };
  const launched: ReturnType<typeof startHolder>[] = [];
  const orphanPids = new Set<number>();
  const checks: string[] = [];
  let passed = false;
  const launch = (withChild = false) => {
    const process = startHolder(root, ports, withChild);
    launched.push(process);
    return process;
  };
  try {
    const first = launch(true);
    const initial = await first.ready;
    assert.ok(initial.childPid);
    orphanPids.add(initial.childPid);
    const path = join(root, ".openbot/cloudflare/mobile-run.1.lock");
    const original = await readFile(path, "utf8");
    const blocked = launch();
    await assert.rejects(blocked.ready, /still owns the lock/u);
    assert.equal(await blocked.exit, 1);
    assert.equal(await readFile(path, "utf8"), original);
    checks.push("A live launcher rejects another start without changing its record.");

    first.child.kill("SIGKILL");
    await first.exit;
    const survivor = launch();
    await assert.rejects(survivor.ready, /still owns the lock/u);
    assert.equal(await survivor.exit, 1);
    assert.equal(await readFile(path, "utf8"), original);
    process.kill(initial.childPid, "SIGTERM");
    await waitAbsent(initial.childPid);
    orphanPids.delete(initial.childPid);
    checks.push("A crashed launcher cannot be replaced while one of its recorded children survives.");

    const contenders = [launch(), launch(), launch(), launch()];
    const results = await Promise.allSettled(contenders.map((candidate) => candidate.ready));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const [index, result] of results.entries()) {
      const candidate = contenders[index];
      assert.ok(candidate);
      if (result.status === "fulfilled") candidate.child.stdin?.end("release\n");
      else assert.equal(await candidate.exit, 1);
    }
    await Promise.all(contenders.map((candidate) => candidate.exit));
    assert.equal(await readFile(path, "utf8"), original);
    const next = JSON.parse(await readFile(join(root, ".openbot/cloudflare/mobile-run.2.lock"), "utf8"));
    assert.equal(next.released, true);
    assert.deepEqual((await readdir(join(root, ".openbot/cloudflare"))).sort(), [
      "mobile-run.1.lock",
      "mobile-run.2.lock",
    ]);
    checks.push("Competing crash recoveries elect one owner; stale and clean-release records remain available.");

    const variants = [
      { name: "malformed", contents: "not-json" },
      {
        name: "foreign",
        contents: JSON.stringify({
          launcherPid: initial.pid,
          startedAt: new Date().toISOString(),
          projectRoot: "/other/project",
        }),
      },
      {
        name: "live-unrelated",
        contents: JSON.stringify({ launcherPid: process.pid, startedAt: new Date().toISOString(), projectRoot: "" }),
      },
    ];
    for (const variant of variants) {
      const fixture = join(root, variant.name);
      const directory = join(fixture, ".openbot/cloudflare");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lockPath = join(directory, "mobile-run.lock");
      const contents =
        variant.name === "live-unrelated"
          ? variant.contents.replace('"projectRoot":""', `"projectRoot":${JSON.stringify(fixture)}`)
          : variant.contents;
      await writeFile(lockPath, contents, { mode: 0o600 });
      await assert.rejects(acquireIndependentMobileLock(fixture, ports));
      assert.equal(await readFile(lockPath, "utf8"), contents);
    }
    const linked = join(root, "symlink");
    await mkdir(join(linked, ".openbot/cloudflare"), { recursive: true, mode: 0o700 });
    const target = join(linked, "retained.txt");
    await writeFile(target, "retained", { mode: 0o600 });
    await symlink(target, join(linked, ".openbot/cloudflare/mobile-run.lock"));
    await assert.rejects(acquireIndependentMobileLock(linked, ports));
    assert.equal(await readFile(target, "utf8"), "retained");
    checks.push("Unreadable, foreign, live unrelated and symlink lock records remain untouched.");

    const legacy = join(root, "legacy");
    const legacyDirectory = join(legacy, ".openbot/cloudflare");
    await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
    const legacyContents = JSON.stringify({
      launcherPid: initial.pid,
      startedAt: new Date().toISOString(),
      projectRoot: legacy,
    });
    await writeFile(join(legacyDirectory, "mobile-run.lock"), legacyContents, { mode: 0o600 });
    const recovered = await acquireIndependentMobileLock(legacy, ports);
    recovered.release();
    assert.equal(await readFile(join(legacyDirectory, "mobile-run.lock"), "utf8"), legacyContents);
    checks.push("A confirmed dead legacy owner can be superseded without deleting its record.");

    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      await assert.rejects(
        acquireIndependentMobileLock(legacy, { ...ports, signalPort: address.port }),
        /port is already in use/u,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    checks.push("An occupied service port prevents recovery before another service is started.");

    const diagnostics: string[] = [];
    const detach = teeLogLines(["independent-mobile"], (line) => diagnostics.push(line));
    let stopped = false;
    try {
      const child = startIndependentMobileChild(
        "tunnel",
        process.execPath,
        ["--eval", 'process.stderr.write("fixture-private-output"); process.exit(23)'],
        {
          projectRoot: root,
          environment: { PATH: process.env.PATH },
          requestedStop: () => false,
          stopped: () => {
            stopped = true;
          },
        },
      );
      await once(child, "exit");
      assert.equal(stopped, true);
      assert.ok(diagnostics.some((line) => line.includes('"component":"tunnel"') && line.includes('"code":23')));
      assert.ok(diagnostics.every((line) => !line.includes("fixture-private-output")));
    } finally {
      detach();
    }
    checks.push("A real child exit reports its component and exit code without forwarding private child output.");
    passed = true;
  } finally {
    for (const holder of launched) {
      if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill("SIGKILL");
    }
    await Promise.allSettled(launched.map((holder) => holder.exit));
    for (const pid of orphanPids) {
      try {
        process.kill(pid, "SIGTERM");
        await waitAbsent(pid);
      } catch {
        /* Only owned fixture processes are cleaned. */
      }
    }
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--holder") {
  void holder().catch((error) => {
    logger.error(error instanceof Error ? error.message : "Fixture launcher failed.");
    process.exitCode = 1;
  });
} else {
  await main();
}
