// This flag is replaced by the macOS build. Ordinary builds omit the sink.
declare const KEPOS_ACCEPTANCE_DIAGNOSTICS: boolean | undefined;
const enabled = typeof KEPOS_ACCEPTANCE_DIAGNOSTICS !== "undefined" && KEPOS_ACCEPTANCE_DIAGNOSTICS;

export type AcceptanceEvent = "admission_unknown" | "admission_accepted" | "source_mismatch" |
  "policy_rejected" | "policy_admitted" | "packet_busy";

let sink: ((event: AcceptanceEvent) => void) | undefined;
const emitted = new Map<AcceptanceEvent, number>();
let mismatchSeen = false;

export function setAcceptanceSink(next?: (event: AcceptanceEvent) => void): void {
  if (!enabled) return;
  sink = next;
  emitted.clear();
  mismatchSeen = false;
}

export function acceptanceEvent(event: AcceptanceEvent): void {
  if (!enabled || !sink) return;
  if (event === "source_mismatch") mismatchSeen = true;
  // Preserve the limited positive-control budget for the spoof test even if
  // a previous phase carried ordinary traffic in the same tunnel.
  if (event === "policy_admitted" && !mismatchSeen) return;
  if ((emitted.get(event) ?? 0) >= 3) return;
  emitted.set(event, (emitted.get(event) ?? 0) + 1);
  try { sink(event); } catch { /* Diagnostics must not affect policy. */ }
}
