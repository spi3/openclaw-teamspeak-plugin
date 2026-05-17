const stubModules = new Map([
  [
    "openclaw/plugin-sdk/core",
    `
export function createChannelPluginBase(config) {
  return config;
}

export function createChatChannelPlugin(config) {
  return config;
}

export function defineChannelPluginEntry(entry) {
  return entry;
}
`
  ],
  [
    "openclaw/plugin-sdk/config-runtime",
    `
export function loadSessionStore() {
  return {};
}

export function resolveSessionStoreEntry() {
  return { existing: null };
}
`
  ],
  [
    "openclaw/plugin-sdk/inbound-reply-dispatch",
    `
export async function dispatchInboundReplyWithBase() {
}
`
  ],
  [
    "openclaw/plugin-sdk/runtime-store",
    `
export function createPluginRuntimeStore(options = {}) {
  let runtime = null;
  return {
    setRuntime(nextRuntime) {
      runtime = nextRuntime;
    },
    getRuntime() {
      if (!runtime) {
        throw new Error(options.errorMessage || "test runtime is not initialized");
      }
      return runtime;
    }
  };
}
`
  ],
  [
    "openclaw/plugin-sdk/security-runtime",
    `
export function wrapExternalContent(content, options = {}) {
  const source = options.source || "unknown";
  return [
    "<<<external_untrusted_content:test>>>",
    \`Source: \${source}\`,
    "---",
    content,
    "<<<end_external_untrusted_content:test>>>"
  ].join("\\n");
}
`
  ],
  [
    "openclaw/plugin-sdk/webhook-ingress",
    `
export async function readJsonWebhookBodyOrReject() {
  return { ok: false };
}
`
  ]
]);

export async function resolve(specifier, context, nextResolve) {
  const stub = stubModules.get(specifier);
  if (stub) {
    return {
      url: `data:text/javascript;charset=utf-8,${encodeURIComponent(stub)}`,
      shortCircuit: true
    };
  }
  return nextResolve(specifier, context);
}
