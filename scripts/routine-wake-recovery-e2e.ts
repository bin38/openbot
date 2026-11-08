import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RoutineWake } from "../src/main/routine-wake";

function event() {
  let signal: () => void = () => {};
  const promise = new Promise<void>((done) => {
    signal = done;
  });
  return { promise, signal };
}
async function observed(promise: Promise<void>): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, fail) => {
        deadline = setTimeout(() => fail(new Error("Wake service did not resume.")), 3_000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
const checks: string[] = [];
let passed = false;
try {
  const recovered = event();
  let suspends = 0;
  let resumes = 0;
  const wake = new RoutineWake({
    routines: {
      suspendRoutines: () => {
        suspends += 1;
      },
      resumeRoutines: () => {
        resumes += 1;
        recovered.signal();
      },
    },
    isOnline: () => true,
    pollMs: 1,
    onlineReads: 1,
    lostResumeMs: 2,
  });
  wake.suspend();
  await observed(recovered.promise);
  assert.equal(suspends, 1);
  assert.equal(resumes, 1);
  wake.dispose();
  checks.push("Routines resume after a suspend when the OS resume event is missing.");

  const online = event();
  let reads = 0;
  const network = new RoutineWake({
    routines: { suspendRoutines: () => {}, resumeRoutines: () => online.signal() },
    isOnline: () => ++reads > 1,
    pollMs: 1,
    onlineReads: 2,
    lostResumeMs: 100,
  });
  network.suspend();
  network.resume();
  await observed(online.promise);
  assert.equal(reads, 3);
  network.dispose();
  checks.push("A normal wake waits for consecutive online reads.");

  let unwanted = 0;
  const disposed = new RoutineWake({
    routines: {
      suspendRoutines: () => {},
      resumeRoutines: () => {
        unwanted += 1;
      },
    },
    isOnline: () => true,
    onlineReads: 1,
    lostResumeMs: 1,
  });
  disposed.suspend();
  disposed.dispose();
  const sentinel = event();
  const control = new RoutineWake({
    routines: { suspendRoutines: () => {}, resumeRoutines: () => sentinel.signal() },
    isOnline: () => true,
    onlineReads: 1,
    lostResumeMs: 4,
  });
  control.suspend();
  await observed(sentinel.promise);
  assert.equal(unwanted, 0);
  control.dispose();
  checks.push("Disposal cancels the owned recovery timer while another real wake service can still resume.");
  passed = true;
} finally {
  const out = resolve(".openbot-build/routine-wake-recovery-e2e");
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/report.json`, JSON.stringify({ passed, checks }, null, 2));
}
