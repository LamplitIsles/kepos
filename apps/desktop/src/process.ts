export function desktopLaunchArguments(
  processArguments: readonly string[],
): string[] {
  return processArguments.slice(1);
}
