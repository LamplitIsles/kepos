import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { IPC_CONTROL, WorkletFraming } from "../src/vpn/worklet-framing.js";

class DelayedDuplex extends Duplex {
  complete?: (error?: Error | null) => void;
  override _read(): void {}
  override _write(_data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.complete = done;
  }
}

test("a worklet frame is not reported sent until the stream completes the write", async () => {
  const stream = new DelayedDuplex();
  const framing = new WorkletFraming(stream);
  let settled = false;
  const sent = framing.send(IPC_CONTROL, Buffer.from("stopped")).then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(stream.complete);
  stream.complete();
  await sent;
  assert.equal(settled, true);
  stream.destroy();
});

test("closing a stalled stream rejects the pending worklet frame", async () => {
  const stream = new DelayedDuplex();
  const framing = new WorkletFraming(stream);
  const sent = framing.send(IPC_CONTROL, Buffer.from("stopped"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  stream.destroy();
  await assert.rejects(sent, /IPC is closed/);
});

test("a failed write rejects the pending frame", async () => {
  const stream = new DelayedDuplex();
  const framing = new WorkletFraming(stream);
  const sent = framing.send(IPC_CONTROL, Buffer.from("stopped"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(stream.complete);
  stream.complete(new Error("write failed"));
  await assert.rejects(sent, /write failed/);
  await new Promise<void>((resolve) => stream.once("close", resolve));
});
