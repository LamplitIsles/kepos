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
    .addItem(trayItemIds.detail, "Preparing peer network…", { enabled: false })
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
    return { status: "Kepos — Starting…", detail: "Preparing peer network…" };
  }
  if (snapshot.appPhase === "stopping") {
    return { status: "Kepos — Stopping…", detail: "Stopping peer network…" };
  }
  if (snapshot.appPhase === "stopped") {
    return { status: "Kepos — Stopped", detail: "Peer network stopped" };
  }

  const peer = snapshot.peer;
  if (!peer || peer.phase === "failed" || peer.phase === "stopped") {
    return { status: "Kepos — Attention needed", detail: "Open Kepos for details" };
  }
  if (peer.phase === "starting" || peer.phase === "stopping") {
    return { status: "Kepos — Online", detail: "Updating peer network…" };
  }
  if (peer.pairing?.phase === "inviting") {
    return { status: "Kepos — Waiting for pairing", detail: "Peer invitation ready" };
  }
  const connected = peer.connections.filter(({ status }) => status === "connected").length;
  const available = peer.services.filter(({ available: ready }) => ready).length;
  return { status: "Kepos — Online", detail: `${available} services · ${connected} peers` };
}
