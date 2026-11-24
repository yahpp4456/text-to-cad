import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CODEX_MODEL,
  CODEX_EFFORT,
  codexBinary,
  codexEnv,
} from "../provider.mjs";
import { fileTools, queryFiles } from "./codexFiles.mjs";

export async function codexTurn({
  mcp,
  allowed,
  session,
  instructions,
  content,
  abort,
  emit,
  onThread,
  onTool,
}) {
  const cwd = path.join(os.tmpdir(), "cadchat-codex-workspace");
  await fs.mkdir(cwd, { recursive: true });
  abort.signal.throwIfAborted();
  const disabled = [
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "apps",
    "plugins",
    "hooks",
    "code_mode",
    "browser_use",
    "computer_use",
    "image_generation",
    "view_image",
    "skill_search",
  ];
  const config = [
    'forced_login_method="chatgpt"',
    'web_search="disabled"',
    ...disabled.map((f) => "features." + f + "=false"),
  ];
  const child = spawn(
    codexBinary(),
    ["app-server", "--listen", "stdio://", ...config.flatMap((c) => ["-c", c])],
    {
      cwd,
      env: codexEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const reader = createInterface({ input: child.stdout });
  const frames = reader[Symbol.asyncIterator]();
  let failure;
  const stop = () => {
    reader.close();
    child.kill();
  };
  const fail = (err) => {
    failure = err;
    stop();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  const timer = setTimeout(
    () => fail(new Error("Codex 回合逾時")),
    15 * 60 * 1000,
  );
  abort.signal.addEventListener("abort", stop, { once: true });
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");
  async function receive() {
    const line = await frames.next();
    abort.signal.throwIfAborted();
    if (line.done) throw failure || new Error("Codex 連線已結束");
    return JSON.parse(line.value);
  }
  let serial = 0;
  async function request(method, params) {
    const id = ++serial;
    send({ id, method, params });
    for (;;) {
      const frame = await receive();
      if (frame.method && frame.id != null)
        throw new Error("Codex 要求未啟用的權限");
      if (frame.id !== id) continue;
      if (frame.error) throw new Error(frame.error.message);
      return frame.result;
    }
  }
  const client = new Client({ name: "cadchat", version: "1" });
  try {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.instance.connect(serverSide);
    await client.connect(clientSide);
    const cadTools = (await client.listTools()).tools
      .filter((t) => allowed.includes("mcp__cadchat__" + t.name))
      .map(({ name, description, inputSchema }) => ({
        type: "function",
        name,
        description,
        inputSchema,
      }));
    const reads = fileTools.filter((t) => allowed.includes(t.name));
    const dynamicTools = [...cadTools, ...reads];
    await request("initialize", {
      clientInfo: { name: "cadchat", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const { account } = await request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt")
      throw new Error("請先以 ChatGPT 登入 Codex CLI");
    const { config: globalConfig } = await request("config/read", {
      includeLayers: false,
    });
    const settings = {
      cwd,
      model: CODEX_MODEL,
      modelProvider: "openai",
      baseInstructions: instructions,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: Object.fromEntries(
        Object.keys(globalConfig.mcp_servers || {}).map((k) => [
          "mcp_servers." + k + ".enabled",
          false,
        ]),
      ),
    };
    const start = () =>
      request("thread/start", {
        ...settings,
        dynamicTools,
        environments: [],
        selectedCapabilityRoots: [],
        allowProviderModelFallback: false,
      });
    let thread;
    if (session.sdkSessionId) {
      try {
        ({ thread } = await request("thread/resume", {
          ...settings,
          threadId: session.sdkSessionId,
        }));
      } catch (err) {
        if (
          !/no rollout found|(?:thread|rollout|session).*not found/i.test(
            err.message,
          )
        )
          throw err;
        ({ thread } = await start());
        content = [
          { type: "text", text: (session.history || []).join("\n") },
          ...content,
        ];
      }
    } else ({ thread } = await start());
    onThread(thread.id);
    const input = content.map((b) =>
      b.type === "text"
        ? b
        : {
            type: "image",
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
    );
    const turnId = ++serial;
    send({
      id: turnId,
      method: "turn/start",
      params: {
        threadId: thread.id,
        environments: [],
        model: CODEX_MODEL,
        effort: CODEX_EFFORT,
        input,
      },
    });
    for (;;) {
      const frame = await receive();
      if (frame.id === turnId && frame.error)
        throw new Error(frame.error.message);
      const p = frame.params;
      if (frame.method && frame.id != null) {
        if (frame.method !== "item/tool/call" || p.threadId !== thread.id)
          throw new Error("Codex 要求未啟用的工具");
        try {
          let result;
          if (reads.some((t) => t.name === p.tool)) {
            result = {
              content: [
                {
                  type: "text",
                  text: await queryFiles(
                    p.tool,
                    p.arguments,
                    session,
                    abort.signal,
                  ),
                },
              ],
            };
          } else {
            if (!cadTools.some((t) => t.name === p.tool))
              throw new Error("工具不屬於目前模式");
            onTool(p.tool);
            result = await client.callTool(
              { name: p.tool, arguments: p.arguments },
              undefined,
              { timeout: 900000, signal: abort.signal },
            );
          }
          abort.signal.throwIfAborted();
          const contentItems = result.content.map((b) =>
            b.type === "image"
              ? {
                  type: "inputImage",
                  imageUrl: `data:${b.mimeType};base64,${b.data}`,
                }
              : { type: "inputText", text: b.text || "" },
          );
          send({
            id: frame.id,
            result: { success: !result.isError, contentItems },
          });
        } catch (err) {
          abort.signal.throwIfAborted();
          send({
            id: frame.id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: err.message }],
            },
          });
        }
      } else if (p?.threadId === thread.id) {
        if (frame.method === "item/started" && p.item.type === "agentMessage")
          emit("ai_start", {});
        if (frame.method === "item/agentMessage/delta")
          emit("ai_delta", { text: p.delta });
        if (frame.method === "item/completed" && p.item.type === "agentMessage")
          emit("ai", { text: p.item.text });
        if (frame.method === "turn/completed") {
          if (p.turn.status !== "completed")
            throw new Error(p.turn.error?.message || "Codex 回合已中斷");
          return;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", stop);
    stop();
    await client.close();
    await mcp.instance.close();
  }
}
