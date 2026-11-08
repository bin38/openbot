import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger, teeLogLines } from "@openbot/logging";
import { Effect, Fiber } from "effect";
import { ColabFailure } from "../src/backend/colab-errors";
import { type ColabProcess, startColabProcess } from "../src/main/colab-cli";
import { ColabService } from "../src/main/colab-service";

const logger = createOpenBotLogger("colab-service-e2e");
const output = resolve(".openbot-build/colab-service-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-colab-e2e-"));
const home = join(root, "home");
const executable = join(root, "colab");
const artifacts = join(root, "artifacts");
const calls = join(home, "calls.jsonl");
const modePath = join(home, "mode.json");
const authPath = join(home, ".config/colab-cli/token.json");
const checks: string[] = [];
let passed = false;

const fixture = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const home=process.env.HOME,args=process.argv.slice(2),cmd=args[0];
fs.mkdirSync(home,{recursive:true});
const calls=path.join(home,'calls.jsonl'),modePath=path.join(home,'mode.json');
const auth=path.join(home,'.config/colab-cli/token.json'),sessions=path.join(home,'session-names.json');
let mode={};try{mode=JSON.parse(fs.readFileSync(modePath,'utf8'))}catch{}
fs.appendFileSync(calls,JSON.stringify({args,proxy:process.env.HTTP_PROXY??null,noProxy:process.env.NO_PROXY??null})+'\\n');
const names=()=>{try{return JSON.parse(fs.readFileSync(sessions,'utf8'))}catch{return[]}};
const save=(value)=>fs.writeFileSync(sessions,JSON.stringify(value));
const option=(name)=>args[args.indexOf(name)+1];
const lines=()=>names().forEach((name)=>console.log('['+name+'] fixture-endpoint | Hardware: CPU | Shape: Standard | Variant: DEFAULT | Status: IDLE'));
async function main(){
 if(cmd==='version'){console.log('Version: 0.7.5');return}
 if(cmd==='stdin-closed'){fs.closeSync(0);setInterval(()=>{},1000);return}
 if(mode.fail){console.error('Bearer fixture-colab-access-secret; refresh_token=fixture-colab-refresh-secret');process.exitCode=9;return}
 if(!fs.existsSync(auth)||mode.forceAuth){
  console.error('To authorize colab-cli, visit this URL in any browser:');
  const link='https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=fixture&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fapplicationdefaultauthcode.html&state=fixture-state';
  process.stderr.write(link.slice(0,120));
  await new Promise((done)=>setImmediate(done));
  process.stderr.write(link.slice(120)+'\\n');
  process.stderr.write('Enter the authorization code: ');
  let input='';for await(const chunk of process.stdin)input+=chunk;
  if(input.trim()!=='fixture-google-authorization-code'){console.error('invalid authorization');process.exitCode=7;return}
  fs.mkdirSync(path.dirname(auth),{recursive:true});fs.writeFileSync(auth,JSON.stringify({token:'fixture-colab-access-secret',refresh_token:'fixture-colab-refresh-secret'}),{mode:0o600});
 }
 if(cmd==='sessions'||cmd==='status'){lines();return}
 if(cmd==='new'){save([...new Set([...names(),option('--session')])]);console.log('[colab] Session READY.');return}
 if(cmd==='stop'){save(names().filter((name)=>name!==option('--session')));console.log('[colab] Session terminated.');return}
 if(cmd==='exec'){
  if(args.includes('--file')){const file=option('--file');const data=JSON.parse(fs.readFileSync(file,'utf8'));data.executed=true;fs.writeFileSync(file,JSON.stringify(data));console.log('notebook complete');return}
  let input='';for await(const chunk of process.stdin)input+=chunk;
  if(mode.hangCode){fs.writeFileSync(path.join(home,'hang-ready'),String(process.pid));setInterval(()=>{},1000);return}
  if(input==='echo-token'){console.log('fixture-colab-access-secret');return}
  console.log('executed: '+input);return
 }
 if(cmd==='ls'){console.log('data.csv');console.log('notebook.ipynb');return}
 if(cmd==='upload'){const file=args[args.length-2];fs.writeFileSync(path.join(home,'transfer.json'),JSON.stringify({bytes:fs.statSync(file).size,remote:args.at(-1)}));console.log('uploaded');return}
 if(cmd==='download'){fs.writeFileSync(args.at(-1),'downloaded fixture data');console.log('downloaded');return}
 if(cmd==='url'){console.log('https://colab.research.google.com/notebooks/empty.ipynb?dbu=%2Ftun%2Fm%2Ffixture-endpoint#datalabBackendUrl=https://colab.research.google.com/tun/m/fixture-endpoint');return}
 process.exitCode=4
}
main().catch(()=>{process.exitCode=6});
`;

async function callLog(): Promise<Array<{ args: string[]; proxy: string | null; noProxy: string | null }>> {
  try {
    return (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

try {
  await mkdir(home, { recursive: true });
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  await writeFile(modePath, "{}");
  const service = new ColabService({
    executable,
    homeDirectory: home,
    artifactsDirectory: artifacts,
    proxySettings: () => ({ enabled: true, proxyUrl: "http://127.0.0.1:31234" }),
  });
  const logs: string[] = [];
  const detach = teeLogLines(["colab"], (line) => logs.push(line));
  try {
    const initial = await Effect.runPromise(service.getStatus());
    assert.equal(initial.installed, true);
    assert.equal(initial.version, "0.7.5");
    assert.equal(initial.credentialsPresent, false);
    assert.equal(
      (await callLog()).some((call) => call.args[0] === "new"),
      false,
    );
    await assert.rejects(Effect.runPromise(service.refresh()), /Sign in to Colab/u);
    checks.push("Detection uses the real CLI process without authentication or runtime creation.");

    const login = await Effect.runPromise(service.startLogin());
    assert.equal(login.loginPhase, "waiting-code");
    assert.equal(login.canOpenAuthorization, true);
    assert.equal(JSON.stringify(login).includes("accounts.google.com"), false);
    assert.equal(JSON.stringify(login).includes("fixture-google-authorization-code"), false);
    assert.ok(service.authorizationUrl().startsWith("https://accounts.google.com/o/oauth2/auth?"));
    assert.ok(service.authorizationUrl().includes("state=fixture-state"));
    await Effect.runPromise(service.submitLoginCode("fixture-google-authorization-code"));
    const authenticated = await Effect.runPromise(service.getStatus());
    assert.equal(authenticated.connected, true);
    assert.equal(authenticated.credentialsPresent, true);
    assert.equal(
      (await callLog()).some((call) => call.args[0] === "new"),
      false,
    );
    const tokenBefore = await readFile(authPath, "utf8");
    checks.push("Official-style OAuth code input is private, completes through stdin and creates no compute runtime.");

    if (process.getuid) {
      const sessionsCache = join(home, ".config", "colab-cli", "sessions.json");
      const sessionsContent = '{"fixture":"unchanged"}';
      await chmod(authPath, 0o644);
      await writeFile(sessionsCache, sessionsContent, { mode: 0o644 });
      await Effect.runPromise(service.refresh());
      assert.equal((await stat(authPath)).mode & 0o777, 0o600);
      assert.equal((await stat(sessionsCache)).mode & 0o777, 0o600);
      assert.equal(await readFile(authPath, "utf8"), tokenBefore);
      assert.equal(await readFile(sessionsCache, "utf8"), sessionsContent);

      for (const kind of ["parent-link", "file-link", "hard-link"]) {
        const unsafeHome = join(root, kind);
        const external = join(root, `${kind}-external`);
        await mkdir(external);
        const sentinel = join(external, "token.json");
        await writeFile(sentinel, "unchanged sentinel", { mode: 0o644 });
        await chmod(sentinel, 0o644);
        await mkdir(unsafeHome);
        if (kind === "parent-link") await symlink(external, join(unsafeHome, ".config"));
        else {
          const cache = join(unsafeHome, ".config", "colab-cli");
          await mkdir(cache, { recursive: true });
          if (kind === "file-link") await symlink(sentinel, join(cache, "token.json"));
          else await link(sentinel, join(cache, "token.json"));
        }
        const unsafeService = new ColabService({
          executable,
          homeDirectory: unsafeHome,
          artifactsDirectory: join(root, `${kind}-artifacts`),
        });
        try {
          await assert.rejects(Effect.runPromise(unsafeService.getStatus()), /could not secure the Colab CLI cache/u);
          assert.equal(await readFile(sentinel, "utf8"), "unchanged sentinel");
          assert.equal((await stat(sentinel)).mode & 0o777, 0o644);
        } finally {
          await Effect.runPromise(unsafeService.close());
        }
      }
      checks.push(
        "Official cache files become private without content changes; linked cache parents and files fail without changing their external targets.",
      );
    }

    await Effect.runPromise(service.createCpu({ name: "notebook-1" }));
    await Effect.runPromise(service.createCpu({ name: "notebook-1" }));
    const allocations = (await callLog()).filter((call) => call.args[0] === "new");
    assert.equal(allocations.length, 1);
    assert.deepEqual(allocations[0]?.args, ["new", "--session", "notebook-1"]);
    assert.equal((await Effect.runPromise(service.getStatus())).sessions[0]?.name, "notebook-1");
    checks.push(
      "CPU creation is explicit and repeated named requests reuse the existing runtime without accelerator flags.",
    );

    await writeFile(join(home, "session-names.json"), JSON.stringify(["notebook-1", " spaced-runtime "]));
    assert.ok(
      (await Effect.runPromise(service.refresh())).sessions.some((session) => session.name === " spaced-runtime "),
    );
    await Effect.runPromise(service.createCpu({ name: " spaced-runtime " }));
    assert.equal((await callLog()).filter((call) => call.args[0] === "new").length, 1);
    checks.push(
      "Existing CLI runtime identifiers retain whitespace exactly and are not replaced by a different named allocation.",
    );

    const result = await Effect.runPromise(
      service.execute({ session: "notebook-1", code: "print('hello')", timeoutSeconds: 3 }),
    );
    assert.equal(result.text.trim(), "executed: print('hello')");
    const redacted = await Effect.runPromise(service.execute({ session: "notebook-1", code: "echo-token" }));
    assert.equal(redacted.text.includes("fixture-colab-access-secret"), false);
    const proxyCall = (await callLog()).find((call) => call.args[0] === "exec");
    assert.equal(proxyCall?.proxy, "http://127.0.0.1:31234");
    assert.ok(proxyCall?.noProxy?.includes("localhost"));
    assert.ok(
      (await Effect.runPromise(service.listFiles({ session: "notebook-1", path: "content" }))).text.includes(
        "data.csv",
      ),
    );
    assert.ok(
      (await Effect.runPromise(service.sessionUrl("notebook-1"))).startsWith("https://colab.research.google.com/"),
    );
    checks.push(
      "Execution, files and browser URL use the intended runtime and app proxy; known credentials are redacted from returned output.",
    );

    const sourcePath = join(root, "data.bin");
    await writeFile(sourcePath, Buffer.alloc(131072, 0x41));
    const source = await open(sourcePath, "r");
    try {
      const uploaded = await Effect.runPromise(
        service.uploadSource("notebook-1", "content/data.bin", { path: sourcePath, handle: source }),
      );
      assert.equal(uploaded.bytes, 131072);
      assert.equal((await source.stat()).size, 131072);
    } finally {
      await source.close();
    }
    const notebookPath = join(root, "notebook.ipynb");
    const notebook = '{"cells":[],"nbformat":4}';
    await writeFile(notebookPath, notebook);
    const notebookSource = await open(notebookPath, "r");
    try {
      await Effect.runPromise(
        service.executeNotebookSource("notebook-1", { path: notebookPath, handle: notebookSource }),
      );
    } finally {
      await notebookSource.close();
    }
    assert.equal(await readFile(notebookPath, "utf8"), notebook);
    const downloaded = await Effect.runPromise(
      service.download("notebook-1", "content/result.txt", "result.txt", (source) =>
        Effect.promise(() => source.handle.readFile("utf8")),
      ),
    );
    assert.equal(downloaded, "downloaded fixture data");
    assert.deepEqual(await readdir(artifacts), []);
    await assert.rejects(
      Effect.runPromise(service.download("notebook-1", "content/result.txt", "../outside", () => Effect.void)),
    );
    checks.push(
      "Pinned workspace sources stream through private staging, notebook originals stay intact, and managed downloads clean up.",
    );

    await writeFile(modePath, JSON.stringify({ hangCode: true }));
    const running = Effect.runFork(service.execute({ session: "notebook-1", code: "wait-for-cancel" }));
    const deadline = Date.now() + 5_000;
    let ownedPid = 0;
    while (!ownedPid) {
      try {
        ownedPid = Number(await readFile(join(home, "hang-ready"), "utf8"));
      } catch {}
      if (Date.now() > deadline) throw new Error("The owned Colab fixture did not start execution.");
      if (!ownedPid) await new Promise<void>((done) => setTimeout(done, 20));
    }
    await Effect.runPromise(Fiber.interrupt(running));
    assert.throws(() => process.kill(ownedPid, 0));
    checks.push("Interrupting an execution waits for its owned CLI child to exit before cleanup.");

    await writeFile(modePath, JSON.stringify({ forceAuth: true }));
    let authorizationNotifications = 0;
    let oauth: ColabProcess | null = null;
    oauth = startColabProcess({
      cli: { executable, python: null },
      args: ["sessions"],
      environment: { PATH: process.env.PATH, HOME: home },
      timeoutMs: 5_000,
      interactive: true,
      onAuthorization: () => {
        authorizationNotifications += 1;
        if (authorizationNotifications === 1) {
          assert.ok(oauth);
          oauth.child.stdin.end("fixture-google-authorization-code\n");
        }
      },
    });
    try {
      await oauth.done;
    } finally {
      if (oauth.child.exitCode === null && oauth.child.signalCode === null) oauth.stop();
    }
    assert.equal(authorizationNotifications, 1);
    const brokenInput = startColabProcess({
      cli: { executable, python: null },
      args: ["stdin-closed"],
      environment: { PATH: process.env.PATH, HOME: home },
      timeoutMs: 5_000,
      input: "x".repeat(1_048_576),
    });
    await assert.rejects(brokenInput.done, (error) => error instanceof ColabFailure && error.code === "commandFailed");
    checks.push(
      "Later CLI output cannot reopen code entry; an early stdin close is a safe command failure, not a host crash.",
    );

    const concurrent = new ColabService({
      executable,
      homeDirectory: home,
      artifactsDirectory: join(root, "concurrent-artifacts"),
    });
    try {
      const before = (await callLog()).filter((call) => call.args[0] === "sessions").length;
      await Promise.all([Effect.runPromise(concurrent.startLogin()), Effect.runPromise(concurrent.startLogin())]);
      const after = (await callLog()).filter((call) => call.args[0] === "sessions").length;
      assert.equal(after - before, 1);
      assert.ok(concurrent.takeAutomaticAuthorizationUrl()?.startsWith("https://accounts.google.com/"));
      assert.equal(concurrent.takeAutomaticAuthorizationUrl(), null);
      await Effect.runPromise(concurrent.cancelLogin());
    } finally {
      await Effect.runPromise(concurrent.close());
    }
    checks.push(
      "Concurrent first-time login requests share one authentication process and one automatic browser opening.",
    );

    await writeFile(modePath, JSON.stringify({ forceAuth: true }));
    assert.equal((await Effect.runPromise(service.startLogin())).loginPhase, "waiting-code");
    const cancelled = await Effect.runPromise(service.cancelLogin());
    assert.equal(cancelled.loginPhase, "idle");
    assert.equal(await readFile(authPath, "utf8"), tokenBefore);
    await writeFile(modePath, JSON.stringify({ fail: true }));
    const failed = await Effect.runPromise(service.startLogin());
    assert.equal(failed.loginPhase, "error");
    assert.equal(failed.message?.includes("fixture-colab-"), false);
    assert.ok(
      logs.every((line) => !line.includes("fixture-colab-") && !line.includes("fixture-google-authorization-code")),
    );
    await writeFile(modePath, "{}");
    await Effect.runPromise(service.stop("notebook-1"));
    assert.deepEqual(
      (await Effect.runPromise(service.getStatus())).sessions.map((session) => session.name),
      [" spaced-runtime "],
    );
    checks.push(
      "Cancellation keeps saved CLI login intact; failures do not leak secrets; explicit stop removes only the selected runtime.",
    );
  } finally {
    detach();
    await Effect.runPromise(service.close());
  }
  passed = true;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), JSON.stringify({ passed, checks }, null, 2));
  await rm(root, { recursive: true, force: true });
  logger.info("Colab service checks finished.", { passed, checks: checks.length });
}
