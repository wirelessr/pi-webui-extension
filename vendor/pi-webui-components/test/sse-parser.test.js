import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseSseBuffer } from "../src/sse-parser.js";

describe("parseSseBuffer - basic parsing", () => {
  test("single complete event", () => {
    const buf = 'data: {"type":"text","text":"hello"}\n\n';
    const { events, rest } = parseSseBuffer(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "text");
    assert.equal(events[0].text, "hello");
    assert.equal(rest, "");
  });

  test("multiple complete events", () => {
    const buf = 'data: {"type":"text","text":"first"}\n\ndata: {"type":"text","text":"second"}\n\n';
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 2);
    assert.equal(events[0].text, "first");
    assert.equal(events[1].text, "second");
  });
});

describe("parseSseBuffer - incomplete events", () => {
  test("incomplete event stays in rest", () => {
    const buf = 'data: {"type":"text","text":"hello"}\n';
    const { events, rest } = parseSseBuffer(buf);
    assert.equal(events.length, 0);
    assert.equal(rest, 'data: {"type":"text","text":"hello"}\n');
  });

  test("complete + incomplete in same buffer", () => {
    const buf = 'data: {"type":"done"}\n\ndata: {"type":"text","text":"partial"}\n';
    const { events, rest } = parseSseBuffer(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "done");
    assert.ok(rest.includes("partial"));
  });

  test("empty buffer", () => {
    const { events, rest } = parseSseBuffer("");
    assert.equal(events.length, 0);
    assert.equal(rest, "");
  });
});

describe("parseSseBuffer - heartbeats and comments", () => {
  test("heartbeat lines are skipped", () => {
    const buf = ": keepalive\n\n";
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 0);
  });

  test("heartbeat between events", () => {
    const buf = 'data: {"type":"a"}\n\n: keepalive\n\ndata: {"type":"b"}\n\n';
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "a");
    assert.equal(events[1].type, "b");
  });
});

describe("parseSseBuffer - malformed data", () => {
  test("invalid JSON in data line is skipped", () => {
    const buf = "data: not json\n\n";
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 0);
  });

  test("non-data lines are ignored", () => {
    const buf = 'event: message\ndata: {"type":"ok"}\n\n';
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "ok");
  });

  test("line without data: prefix is ignored", () => {
    const buf = 'id: 123\ndata: {"type":"ok"}\n\n';
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 1);
  });
});

describe("parseSseBuffer - multi-line data", () => {
  test("multiple data lines in one event", () => {
    const buf = 'data: {"type":"a"}\ndata: {"type":"b"}\n\n';
    const { events } = parseSseBuffer(buf);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "a");
    assert.equal(events[1].type, "b");
  });
});
