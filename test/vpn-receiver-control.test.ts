import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setupPeer } from "../src/state/peer.js";
import { createDefaultCliDependencies, runCli } from "../src/cli/main.js";
import { parseInvitation } from "../src/vpn/invitation.js";
import { startReceiver } from "../src/vpn/receiver.js";
import type { startVpn } from "../src/vpn/runtime.js";
import { ReceiverRouteConflict } from "../src/vpn/linux-tun.js";
import { EnrollmentRejected } from "../src/vpn/enrollment-errors.js";

test("CLI controls the running receiver and changes stop existing sessions before applying", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-control-"));
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  try {
    const stateDir = path.join(root, "peer"), joiningDir = path.join(root, "joining");
    await setupPeer({ stateDir });
    const joiningKey = (await setupPeer({ stateDir: joiningDir })).publicKey;
    let latest!: Parameters<typeof startVpn>[0];
    let routeConflict = false;
    const events: string[] = [];
    const fakeStart: typeof startVpn = async (options) => {
      latest = options; events.push(`start:${options.config.vpn!.peers.length}`);
      return { peerKey: "public", interfaceName: "fake", failed: new Promise<Error>(() => {}), stop: async () => { events.push("stop"); } };
    };
    receiver = await startReceiver({ stateDir, helper: "unused", pool: "198.18.9.0/29",
      config: { peers: [], vpn: { address: "198.18.9.1", peers: [] } }, start: fakeStart,
      checkPool: async () => { if (routeConflict) throw new ReceiverRouteConflict(); } });
    const lines: string[] = [];
    const deps = createDefaultCliDependencies({ stdout: (line) => lines.push(line) });
    await runCli(["peer", "invite", "--state", stateDir], deps);
    const invite = parseInvitation(lines.pop()!);
    routeConflict = true;
    await assert.rejects(latest.enrollment!.enroll(joiningKey, invite.secret, () => true), (error: unknown) => error instanceof EnrollmentRejected && error.reason === "route");
    routeConflict = false;
    await assert.rejects(latest.enrollment!.enroll(joiningKey, invite.secret, () => false), /enrollment ended/);
    const enrolled = await latest.enrollment!.enroll(joiningKey, invite.secret, () => true);
    assert.equal(enrolled.address, "198.18.9.2");
    latest.enrollment!.changed();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(events, ["start:0", "stop", "start:1"]);
    assert.equal(latest.config.vpn!.peers[0]!.allowTcp, "all");
    await runCli(["peer", "grant", "--state", stateDir, "--key", joiningKey, "--ports", "443,8443"], deps);
    assert.deepEqual(events.slice(-2), ["stop", "start:1"]);
    assert.deepEqual(latest.config.vpn!.peers[0]!.allowTcp, [443, 8443]);
    await runCli(["peer", "devices", "--state", stateDir], deps);
    assert.deepEqual(JSON.parse(lines.pop()!), { devices: [{ publicKey: joiningKey, address: "198.18.9.2", allowTcp: [443, 8443] }] });
    await assert.rejects(runCli(["peer", "invite", "--state", stateDir, "--exclude-address", "198.18.9.2"], deps), /inspect devices and revoke/);
    await assert.rejects(runCli(["peer", "invite", "--state", stateDir, "--exclude-address", "bad-secret-input"], deps), (error: unknown) => error instanceof Error && /usable pool address/.test(error.message) && !error.message.includes("bad-secret-input"));
    await runCli(["peer", "revoke", "--state", stateDir, "--key", joiningKey], deps);
    assert.deepEqual(events.slice(-2), ["stop", "start:0"]);
    await runCli(["peer", "invite", "--state", stateDir, "--exclude-address", "198.18.9.2"], deps);
    const recovery = parseInvitation(lines.pop()!);
    assert.equal((await latest.enrollment!.enroll(joiningKey, recovery.secret, () => true)).address, "198.18.9.3");
  } finally { await receiver?.stop(); await rm(root, { recursive: true, force: true }); }
});
