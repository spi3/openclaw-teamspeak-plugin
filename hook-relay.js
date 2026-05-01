#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = {
    secret: "",
    url: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") {
      result.url = String(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (value === "--secret") {
      result.secret = String(argv[index + 1] ?? "");
      index += 1;
    }
  }
  return result;
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

function pickEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

async function postJson(urlString, secret, payload) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;
  await new Promise((resolve, reject) => {
    const request = transport.request(
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
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
            resolve(undefined);
            return;
          }
          reject(
            new Error(
              `bridge ingress rejected hook: ${response.statusCode ?? 500} ${responseBody.trim()}`
            )
          );
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    throw new Error("missing --url");
  }
  if (!args.secret) {
    throw new Error("missing --secret");
  }
  const stdin = await readAllStdin();
  let event = stdin.trim();
  try {
    event = stdin.trim() ? JSON.parse(stdin) : null;
  } catch {
    // Fall back to raw text when daemon stdin is not JSON for some reason.
  }
  await postJson(args.url, args.secret, {
    event,
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
  parseArgs,
  pickEnv,
  postJson,
  isMainModule
};

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
