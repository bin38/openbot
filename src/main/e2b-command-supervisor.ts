/**
 * The guest owns this supervisor and every command it starts. A shell returning does not end its
 * descendants: terminate the session's process group and, on Linux, reap adopted grandchildren
 * (including double-forked or setsid children) before reporting completion to OpenBot.
 */
const SUPERVISOR = String.raw`
import base64, ctypes, errno, os, signal, subprocess, sys

class Interrupted(Exception):
    pass

def interrupt(signum, frame):
    raise Interrupted()

def kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

linux = sys.platform.startswith("linux")
if linux:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        sys.stderr.write("Cannot supervise cloud command descendants.\n")
        sys.exit(125)

for signum in (signal.SIGTERM, signal.SIGINT):
    signal.signal(signum, interrupt)

child = None
result = 125
try:
    command = base64.b64decode(sys.argv[1]).decode("utf-8")
    seconds = int(sys.argv[2]) / 1000
    child = subprocess.Popen(["/bin/sh", "-c", command], start_new_session=True)
    try:
        result = child.wait(timeout=seconds)
        if result < 0:
            result = 128 - result
    except subprocess.TimeoutExpired:
        result = 124
except Interrupted:
    result = 130
except Exception:
    sys.stderr.write("Cloud command supervisor failed.\n")
finally:
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, signal.SIG_IGN)
    if child is not None:
        kill_group(child.pid)
        child.wait()
    if linux:
        children_path = "/proc/self/task/" + str(os.getpid()) + "/children"
        while True:
            with open(children_path, "r") as source:
                children = [int(pid) for pid in source.read().split()]
            for pid in children:
                try:
                    group = os.getpgid(pid)
                    if group != os.getpgrp():
                        kill_group(group)
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                os.waitpid(-1, 0)
            except ChildProcessError:
                break
sys.exit(result)
`;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Arguments also serve the focused real-process check without going through a shell. */
export function e2bCommandSupervisorArguments(command: string, timeoutMs: number): string[] {
  return ["-c", SUPERVISOR, Buffer.from(command, "utf8").toString("base64"), String(timeoutMs)];
}

export function e2bSupervisedCommand(command: string, timeoutMs: number): string {
  return `python3 ${e2bCommandSupervisorArguments(command, timeoutMs).map(quote).join(" ")}`;
}

/** E2B's SDK calls xdotool's click --repeat; it takes wheel steps, not pixels. */
export function e2bScrollSteps(pixels: number): number {
  return Math.min(20, Math.max(1, Math.ceil(pixels / 100)));
}
