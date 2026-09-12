import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("native desktop starts a loopback TCP binding and quits cleanly", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kepos-native-binding-"));
  const occupiedGateway = createServer();
  await new Promise<void>((resolve) => occupiedGateway.listen(0, "127.0.0.1", resolve));
  const occupiedPort = (occupiedGateway.address() as AddressInfo).port;
  try {
    const config = path.join(home, "config");
    await mkdir(path.join(config, "kepos"), { recursive: true });
    await writeFile(path.join(config, "kepos/config.toml"), `
services = []
[network]
bootstrap = []
[gateway]
port = ${occupiedPort}
[[peers]]
label = "fixture"
public_key = "${"ab".repeat(32)}"
connection = "accept"
[[bindings]]
peer = "fixture"
service = "ssh"
listen = { local_port = 0 }
`);
    const ready = path.join(home, "ready.json");
    const quit = path.join(home, "quit");
    const { stdout } = await execute(
      path.resolve("dist/desktop/Kepos.app/Contents/MacOS/Kepos"),
      ["--smoke-test", "--smoke-home", home],
      {
        timeout: 55_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_STATE_HOME: path.join(home, "state"),
          KEPOS_WINDOWS_SMOKE_READY_FILE: ready,
          KEPOS_WINDOWS_SMOKE_RENDER_FILE: path.join(home, "render.json"),
          KEPOS_WINDOWS_SMOKE_QUIT_FILE: quit,
        },
      },
    );
    assert.match(stdout, /KEPOS_DESKTOP_READY/u);
    const snapshot = JSON.parse(await readFile(ready, "utf8"));
    assert.equal(snapshot.peer.phase, "running");
    assert.notEqual(snapshot.peer.gatewayPort, occupiedPort);
    const rendered = JSON.parse(await readFile(path.join(home, "render.json"), "utf8"));
    assert.equal(rendered.role, "peer");
    assert.equal(rendered.peerKeyPresent, true);
    assert.equal(rendered.connectFormVisible, false);
    assert.equal(snapshot.peer.bindings.length, 1);
    assert.equal(snapshot.peer.bindings[0].service, "ssh");
    assert.ok(snapshot.peer.bindings[0].port > 0);
    assert.equal(await readFile(quit, "utf8"), "KEPOS_DESKTOP_QUIT\n");
  } finally {
    await new Promise<void>((resolve, reject) => occupiedGateway.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
