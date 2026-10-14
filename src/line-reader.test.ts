import assert from "node:assert/strict";
import { test } from "node:test";
import { LineReader } from "./line-reader.ts";

test("yields multiple lines from one chunk with line numbers", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push(Buffer.from('{"a":1}\n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
    { text: '{"b":2}', lineNumber: 2, byteOffset: 8, byteLength: 8 },
  ]);
});

test("buffers a line split across pushes", () => {
  const reader = new LineReader();
  const line = '{"key":"a longer value"}\n';
  assert.deepEqual(reader.push(Buffer.from(line.slice(0, 10))), []);
  assert.deepEqual(reader.push(Buffer.from(line.slice(10, 20))), []);
  assert.deepEqual(reader.push(Buffer.from(line.slice(20))), [
    {
      text: line.slice(0, -1),
      lineNumber: 1,
      byteOffset: 0,
      byteLength: Buffer.byteLength(line),
    },
  ]);
});

test("reassembles a UTF-8 code point split across pushes", () => {
  const reader = new LineReader();
  const text = '{"text":"snowman \u{2603} and beyond \u{1f680}"}';
  const bytes = Buffer.from(`${text}\n`);
  const insideRocket = bytes.indexOf(Buffer.from("\u{1f680}")) + 2;
  assert.deepEqual(reader.push(bytes.subarray(0, insideRocket)), []);
  assert.deepEqual(reader.push(bytes.subarray(insideRocket)), [
    {
      text,
      lineNumber: 1,
      byteOffset: 0,
      byteLength: Buffer.byteLength(text) + 1,
    },
  ]);
  assert.deepEqual(reader.push(Buffer.from("next\n")), [
    { text: "next", lineNumber: 2, byteOffset: bytes.length, byteLength: 5 },
  ]);
});

test("emits a torn tail once its newline arrives", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push(Buffer.from('{"a":1}\n{"b"')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
  ]);
  assert.deepEqual(reader.push(Buffer.from(":2}\n")), [
    { text: '{"b":2}', lineNumber: 2, byteOffset: 8, byteLength: 8 },
  ]);
});

test("keeps \\r in text; byteLength is the text's UTF-8 length plus 1", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push(Buffer.from("first\r\n\r\nsecond\r\n")), [
    { text: "first\r", lineNumber: 1, byteOffset: 0, byteLength: 7 },
    { text: "\r", lineNumber: 2, byteOffset: 7, byteLength: 2 },
    { text: "second\r", lineNumber: 3, byteOffset: 9, byteLength: 8 },
  ]);
});

test("delivers blank and whitespace-only lines", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push(Buffer.from('{"a":1}\n\n   \n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
    { text: "", lineNumber: 2, byteOffset: 8, byteLength: 1 },
    { text: "   ", lineNumber: 3, byteOffset: 9, byteLength: 4 },
    { text: '{"b":2}', lineNumber: 4, byteOffset: 13, byteLength: 8 },
  ]);
});

test("empty pushes change nothing", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push(Buffer.alloc(0)), []);
  assert.deepEqual(reader.push(Buffer.from("ab")), []);
  assert.deepEqual(reader.push(Buffer.alloc(0)), []);
  assert.deepEqual(reader.push(Buffer.from("\n")), [
    { text: "ab", lineNumber: 1, byteOffset: 0, byteLength: 3 },
  ]);
});
