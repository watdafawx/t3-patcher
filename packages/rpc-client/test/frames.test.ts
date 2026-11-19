import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FrameJoiner, decodeFrame, encodeFrame } from "../src/index.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../docs/spikes/wp-0d/fixtures/${name}`, import.meta.url)), "utf8");
interface Row {
  sock: string;
  dir?: string;
  ev?: string;
  data: string;
}
const jsonl = (name: string): Row[] =>
  fixture(name)
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);

describe("encode/decode", () => {
  it("encodes client frames exactly as the wire documents them", () => {
    expect(encodeFrame({ _tag: "Request", id: 0, tag: "server.getConfig", payload: {}, headers: [] })).toBe(
      '{"_tag":"Request","id":0,"tag":"server.getConfig","payload":{},"headers":[]}',
    );
    expect(encodeFrame({ _tag: "Ack", requestId: 3 })).toBe('{"_tag":"Ack","requestId":3}');
    expect(encodeFrame({ _tag: "Interrupt", requestId: 3 })).toBe('{"_tag":"Interrupt","requestId":3}');
    expect(encodeFrame({ _tag: "Ping" })).toBe('{"_tag":"Ping"}');
  });

  it("decodes Chunk, Exit and Pong; ignores garbage", () => {
    expect(decodeFrame('{"_tag":"Pong"}')).toEqual({ _tag: "Pong" });
    expect(decodeFrame('{"_tag":"Chunk","requestId":6,"values":[1,2]}')).toEqual({ _tag: "Chunk", requestId: 6, values: [1, 2] });
    expect(decodeFrame('{"_tag":"Exit","requestId":0,"exit":{"_tag":"Success","value":{}}}')).toMatchObject({ _tag: "Exit", requestId: 0 });
    expect(decodeFrame("not json")).toBeUndefined();
    expect(decodeFrame('{"_tag":"Nope"}')).toBeUndefined();
    expect(decodeFrame('{"_tag":"Chunk","requestId":"x","values":[]}')).toBeUndefined();
    expect(decodeFrame("null")).toBeUndefined();
  });
});

describe("FrameJoiner", () => {
  it("passes whole frames through", () => {
    expect(new FrameJoiner().push('{"_tag":"Pong"}')).toBe('{"_tag":"Pong"}');
  });
  it("joins \\u001e-prefixed parts until a frame without the prefix", () => {
    const j = new FrameJoiner();
    expect(j.push('\u001e{"_tag":"Chunk",')).toBeUndefined();
    expect(j.push('\u001e"requestId":1,')).toBeUndefined();
    expect(j.push('"values":[]}')).toBe('{"_tag":"Chunk","requestId":1,"values":[]}');
    expect(j.push('{"_tag":"Pong"}')).toBe('{"_tag":"Pong"}');
  });
});

describe("captured fixtures", () => {
  it("every recv frame of the standalone capture that is not truncated decodes (continuations joined per socket)", () => {
    const joiners = new Map<string, FrameJoiner>();
    const tags = new Set<string>();
    const poisoned = new Set<string>();
    let decoded = 0;
    for (const r of jsonl("standalone-frames.jsonl")) {
      if (r.dir !== "recv") continue;
      const j = joiners.get(r.sock) ?? joiners.set(r.sock, new FrameJoiner()).get(r.sock)!;
      // the fixture truncates long rows (shape tests only): a multi-part frame with any truncated row is dropped whole
      if (r.data.includes("...<truncated")) poisoned.add(r.sock);
      const text = j.push(r.data);
      if (text === undefined) continue;
      if (poisoned.delete(r.sock)) continue;
      const f = decodeFrame(text);
      expect(f, text.slice(0, 120)).toBeDefined();
      tags.add(f!._tag);
      decoded++;
    }
    expect(decoded).toBeGreaterThan(50);
    expect([...tags].sort()).toEqual(["Chunk", "Exit", "Pong"]);
  });

  it("joins the real continuation frames of the app capture into valid JSON frames", () => {
    let joinedParts = 0;
    for (const name of ["app-load.jsonl", "app-thread-open.jsonl", "app-concurrent.jsonl"]) {
      const joiners = new Map<string, FrameJoiner>();
      let complete = 0;
      for (const r of jsonl(name)) {
        if (r.ev !== "recv" || !r.data) continue;
        if (r.data.startsWith("\u001e")) joinedParts++;
        if (r.data.includes("...<truncated")) continue;
        const j = joiners.get(r.sock) ?? joiners.set(r.sock, new FrameJoiner()).get(r.sock)!;
        const text = j.push(r.data);
        if (text === undefined) continue;
        complete++;
        expect(decodeFrame(text), `${name}: ${text.slice(0, 100)}`).toBeDefined();
      }
      expect(complete).toBeGreaterThan(5);
    }
    expect(joinedParts).toBeGreaterThan(0);
  });
});
