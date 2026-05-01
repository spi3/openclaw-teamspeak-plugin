#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_BODY_MAX_BYTES = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function parseArgs(argv) {
  const result = {
    secretFile: "",
    url: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") {
      result.url = String(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (value === "--secret-file") {
      result.secretFile = String(argv[index + 1] ?? "");
      index += 1;
    }
  }
  return result;
}

function readSecretFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) {
    throw new Error("--secret-file must point to a regular file");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("--secret-file must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("--secret-file must be readable only by the current user");
  }
  const secret = fs.readFileSync(filePath, "utf8").trim();
  if (!secret) {
    throw new Error("--secret-file is empty");
  }
  return secret;
}

function readAllStdin(input = process.stdin, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
  return new Promise((resolve, reject) => {
    let buffer = "";
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      input.off("data", handleData);
      input.off("end", handleEnd);
      input.off("error", handleError);
    };
    const finish = (error, value = "") => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        input.pause?.();
        reject(error);
        return;
      }
      resolve(value);
    };
    const handleData = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) {
        finish(new Error(`hook stdin exceeded ${maxBytes} byte limit`));
        return;
      }
      buffer += text;
    };
    const handleEnd = () => finish(null, buffer);
    const handleError = (error) => finish(error);

    input.setEncoding?.("utf8");
    input.on("data", handleData);
    input.on("end", handleEnd);
    input.on("error", handleError);
  });
}

function pickEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

async function postJson(urlString, secret, payload, options = {}) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;
  const requestTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const responseBodyMaxBytes = options.responseBodyMaxBytes ?? DEFAULT_RESPONSE_BODY_MAX_BYTES;
  await new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let request = null;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    };

    try {
      request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(body),
            "x-openclaw-teamspeak-secret": secret
          }
        },
        (response) => {
          let responseBody = "";
          let responseBodyBytes = 0;
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (settled) {
              return;
            }
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            responseBodyBytes += Buffer.byteLength(text, "utf8");
            if (responseBodyBytes > responseBodyMaxBytes) {
              finish(new Error(`bridge ingress response exceeded ${responseBodyMaxBytes} byte limit`));
              request.destroy?.();
              return;
            }
            responseBody += text;
          });
          response.on("end", () => {
            if (settled) {
              return;
            }
            if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
              finish(null);
              return;
            }
            finish(
              new Error(
                `bridge ingress rejected hook: ${response.statusCode ?? 500} ${responseBody.trim()}`
              )
            );
          });
          response.on("error", finish);
        }
      );
    } catch (error) {
      finish(error);
      return;
    }

    timeout = setTimeout(() => {
      const error = new Error(`bridge ingress request timed out after ${requestTimeoutMs}ms`);
      request.destroy?.(error);
      finish(error);
    }, requestTimeoutMs);

    request.on("error", finish);
    try {
      request.end(body);
    } catch (error) {
      finish(error);
    }
  });
}

function parseHookEvent(stdin) {
  let event = stdin.trim();
  try {
    event = stdin.trim() ? JSON.parse(stdin) : null;
  } catch {
    // Fall back to raw text when daemon stdin is not JSON for some reason.
  }
  return event;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    throw new Error("missing --url");
  }
  if (!args.secretFile) {
    throw new Error("missing --secret-file");
  }
  const secret = readSecretFile(args.secretFile);
  const stdin = await readAllStdin();
  await postJson(args.url, secret, {
    event: parseHookEvent(stdin),
    env: {
      TS_MESSAGE_KIND: pickEnv("TS_MESSAGE_KIND"),
      TS_MESSAGE_FROM: pickEnv("TS_MESSAGE_FROM"),
      TS_MESSAGE_TEXT: pickEnv("TS_MESSAGE_TEXT")
    }
  });
}

function isMainModule() {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
}

export const __testInternals = {
  constants: {
    DEFAULT_STDIN_MAX_BYTES,
    DEFAULT_RESPONSE_BODY_MAX_BYTES,
    DEFAULT_REQUEST_TIMEOUT_MS
  },
  parseArgs,
  readSecretFile,
  readAllStdin,
  pickEnv,
  postJson,
  parseHookEvent,
  isMainModule
};

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
