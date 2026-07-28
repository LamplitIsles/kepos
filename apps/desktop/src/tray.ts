import type { DesktopSnapshot } from "./protocol.js";

export const trayItemIds = {
  status: "status",
  detail: "detail",
  open: "open",
  quit: "quit",
} as const;

export interface DesktopTray {
  on(event: "select", listener: (id: string) => void): this;
  addItem(id: string, title: string, options?: { enabled?: boolean }): this;
  addSeparator(): this;
  updateItem(id: string, options: { title?: string; enabled?: boolean }): this;
  destroy(): this;
}

export interface TrayLabels {
  status: string;
  detail: string;
}

export function buildDesktopTray(tray: DesktopTray): DesktopTray {
  return tray
    .addItem(trayItemIds.status, "Kepos — Starting…", { enabled: false })
    .addItem(trayItemIds.detail, "Preparing network roles…", {
      enabled: false,
    })
    .addSeparator()
    .addItem(trayItemIds.open, "Open Kepos")
    .addSeparator()
    .addItem(trayItemIds.quit, "Quit Kepos");
}

export function updateDesktopTray(
  tray: DesktopTray,
  snapshot: DesktopSnapshot,
): void {
  const labels = formatTraySnapshot(snapshot);
  tray.updateItem(trayItemIds.status, { title: labels.status });
  tray.updateItem(trayItemIds.detail, { title: labels.detail });
}

export function formatTraySnapshot(snapshot: DesktopSnapshot): TrayLabels {
  if (snapshot.appPhase === "starting") {
    return {
      status: "Kepos — Starting…",
      detail: "Preparing network roles…",
    };
  }
  if (snapshot.appPhase === "stopping") {
    return {
      status: "Kepos — Stopping…",
      detail: "Stopping network roles…",
    };
  }
  if (snapshot.appPhase === "stopped") {
    return {
      status: "Kepos — Stopped",
      detail: "Network roles stopped",
    };
  }

  const roles = [snapshot.publisher, snapshot.subscriber].filter(
    (role) => role !== undefined,
  );
  if (
    roles.some((role) => role.phase === "failed" || role.phase === "stopped")
  ) {
    return {
      status: "Kepos — Attention needed",
      detail: "Open Kepos for details",
    };
  }
  if (
    roles.some((role) => role.phase === "starting" || role.phase === "stopping")
  ) {
    return {
      status: "Kepos — Online",
      detail: "Updating network roles…",
    };
  }
  if (snapshot.publisher) {
    return {
      status: "Kepos — Online",
      detail: `${snapshot.publisher.services.length} shared · ${snapshot.publisher.activeSubscribers} connected`,
    };
  }
  if (snapshot.subscriber) {
    return {
      status: "Kepos — Online",
      detail: `Remote ${snapshot.subscriber.connection}`,
    };
  }
  return { status: "Kepos — Online", detail: "Not sharing yet" };
}
