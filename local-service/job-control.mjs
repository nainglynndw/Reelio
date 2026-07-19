import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const activeJobs = new Map();

export class JobStoppedError extends Error {
  constructor(message = "Generation stopped by user.") {
    super(message);
    this.name = "JobStoppedError";
  }
}

export async function runWithJobControl(jobId, task) {
  const control = { jobId, stopped: false, children: new Set() };
  activeJobs.set(jobId, control);
  try {
    return await context.run(control, async () => {
      try {
        return await task();
      } catch (error) {
        if (control.stopped) throw new JobStoppedError();
        throw error;
      }
    });
  } finally {
    activeJobs.delete(jobId);
  }
}

export function registerJobProcess(child) {
  const control = context.getStore();
  if (!control) return;
  if (control.stopped) {
    terminate(child);
    return;
  }
  control.children.add(child);
  child.once("close", () => control.children.delete(child));
}

export function assertJobActive() {
  if (context.getStore()?.stopped) throw new JobStoppedError();
}

export function stopJobExecution(jobId) {
  const control = activeJobs.get(jobId);
  if (!control) return false;
  control.stopped = true;
  for (const child of control.children) terminate(child);
  return true;
}

export function stopAllJobExecutions() {
  for (const jobId of activeJobs.keys()) stopJobExecution(jobId);
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_500);
  timer.unref();
}
