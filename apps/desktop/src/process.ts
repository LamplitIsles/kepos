export interface DesktopProcess {
  pid: number;
  kill(pid: number, signal: "SIGTERM"): void;
}

export function desktopLaunchArguments(
  processArguments: readonly string[],
): string[] {
  return processArguments.slice(1);
}

export function terminateDesktopBeforeWindow(process: DesktopProcess): void {
  process.kill(process.pid, "SIGTERM");
}
