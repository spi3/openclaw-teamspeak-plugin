import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { __testInternals as relay } from "../hook-relay.js";

async function withMockHttpRequest(mock, callback) {
  const previous = http.request;
  http.request = mock;
  try {
    await callback();
  } finally {
    http.request = previous;
  }
}

function createMockRequest({ statusCode, responseBody = "", calls }) {
  return (options, onResponse) => {
    const request = new EventEmitter();
    request.end = (body) => {
      calls.push({
        options,
        body
      });
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.setEncoding = () => {};
      onResponse(response);
      queueMicrotask(() => {
        if (responseBody) {
          response.emit("data", responseBody);
        }
        response.emit("end");
      });
    };
    return request;
  };
}

test("parseArgs extracts hook relay URL and secret file", () => {
  assert.deepEqual(
    relay.parseArgs(["--ignored", "value", "--url", "http://127.0.0.1/hook", "--secret-file", "/tmp/secret"]),
    {
      secretFile: "/tmp/secret",
      url: "http://127.0.0.1/hook"
    }
  );
  assert.deepEqual(relay.parseArgs(["--url"]), {
    secretFile: "",
    url: ""
  });
});

test("readSecretFile reads only private regular files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamspeak-relay-secret-"));
  const filePath = path.join(dir, "secret.txt");
  const exposedPath = path.join(dir, "exposed.txt");
  try {
    fs.writeFileSync(filePath, "secret-a\n", { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    assert.equal(relay.readSecretFile(filePath), "secret-a");

    fs.writeFileSync(exposedPath, "secret-b\n", { mode: 0o644 });
    fs.chmodSync(exposedPath, 0o644);
    assert.throws(
      () => relay.readSecretFile(exposedPath),
      /--secret-file must be readable only by the current user/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAllStdin resolves stdin and rejects oversized input", async () => {
  const input = new PassThrough();
  const read = relay.readAllStdin(input, { maxBytes: 8 });
  input.end("hello");
  assert.equal(await read, "hello");

  const oversized = new PassThrough();
  const oversizedRead = relay.readAllStdin(oversized, { maxBytes: 4 });
  oversized.end("12345");
  await assert.rejects(oversizedRead, /hook stdin exceeded 4 byte limit/);
});

test("pickEnv returns only string environment values", () => {
  const previous = process.env.TS_MESSAGE_TEXT;
  try {
    process.env.TS_MESSAGE_TEXT = "hello";
    assert.equal(relay.pickEnv("TS_MESSAGE_TEXT"), "hello");
    delete process.env.TS_MESSAGE_TEXT;
    assert.equal(relay.pickEnv("TS_MESSAGE_TEXT"), "");
  } finally {
    if (previous === undefined) {
      delete process.env.TS_MESSAGE_TEXT;
    } else {
      process.env.TS_MESSAGE_TEXT = previous;
    }
  }
});

test("postJson forwards payload, secret header, and URL path", async () => {
  const calls = [];
  await withMockHttpRequest(
    createMockRequest({
      statusCode: 204,
      calls
    }),
    async () => {
      await relay.postJson("http://127.0.0.1:18789/plugins/teamspeak/inbound?hook=1", "secret-a", {
        event: {
          type: "message.received"
        }
      });
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.hostname, "127.0.0.1");
  assert.equal(calls[0].options.port, "18789");
  assert.equal(calls[0].options.path, "/plugins/teamspeak/inbound?hook=1");
  assert.equal(calls[0].options.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(calls[0].options.headers["x-openclaw-teamspeak-secret"], "secret-a");
  assert.deepEqual(JSON.parse(calls[0].body), {
    event: {
      type: "message.received"
    }
  });
});

test("postJson rejects non-2xx ingress responses with response body context", async () => {
  const calls = [];
  await withMockHttpRequest(
    createMockRequest({
      statusCode: 418,
      responseBody: "nope",
      calls
    }),
    async () => {
      await assert.rejects(
        relay.postJson("http://127.0.0.1:18789/reject", "secret-a", { event: null }),
        /bridge ingress rejected hook: 418 nope/
      );
    }
  );
  assert.equal(calls.length, 1);
});

test("postJson caps ingress response buffering", async () => {
  const calls = [];
  await withMockHttpRequest(
    createMockRequest({
      statusCode: 500,
      responseBody: "response body too large",
      calls
    }),
    async () => {
      await assert.rejects(
        relay.postJson(
          "http://127.0.0.1:18789/reject",
          "secret-a",
          { event: null },
          { responseBodyMaxBytes: 8 }
        ),
        /bridge ingress response exceeded 8 byte limit/
      );
    }
  );
  assert.equal(calls.length, 1);
});

test("postJson times out hanging ingress requests", async () => {
  const calls = [];
  await withMockHttpRequest(
    (options) => {
      const request = new EventEmitter();
      request.end = (body) => {
        calls.push({ options, body });
      };
      request.destroy = (error) => {
        request.emit("error", error);
      };
      return request;
    },
    async () => {
      await assert.rejects(
        relay.postJson(
          "http://127.0.0.1:18789/hang",
          "secret-a",
          { event: null },
          { timeoutMs: 1 }
        ),
        /bridge ingress request timed out after 1ms/
      );
    }
  );
  assert.equal(calls.length, 1);
});
