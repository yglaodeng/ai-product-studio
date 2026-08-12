import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const dataFile = path.join(projectRoot, "data", "sync-events.json");
const studioStateFile = path.join(projectRoot, "data", "studio-state.json");
const clients = new Set();

async function readEvents() {
  try {
    const payload = JSON.parse(await readFile(dataFile, "utf8"));
    return Array.isArray(payload.events) ? payload.events : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeEvents(events) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify({ events }, null, 2)}\n`, "utf8");
  await rename(temporaryFile, dataFile);
}

async function readStudioState() {
  return JSON.parse(await readFile(studioStateFile, "utf8"));
}

async function writeStudioState(state) {
  const current = await readFile(studioStateFile, "utf8").catch(() => "");
  const next = `${JSON.stringify(state, null, 2)}\n`;
  if (current === next) return false;
  const temporaryFile = `${studioStateFile}.tmp`;
  await writeFile(temporaryFile, next, "utf8");
  await rename(temporaryFile, studioStateFile);
  return true;
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function attachSyncApi(server) {
  server.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.5");
    if (!url.pathname.startsWith("/api/sync/") && !url.pathname.startsWith("/api/studio/")) return next();

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sync/events") {
      sendJson(response, 200, { events: await readEvents() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/studio/state") {
      sendJson(response, 200, await readStudioState());
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/studio/state") {
      try {
        const body = await readBody(request);
        if (!Array.isArray(body.nodes) || !body.nodes.every((item) => typeof item?.id === "string" && typeof item?.title === "string")) {
          sendJson(response, 400, { error: "valid_nodes_required" });
          return;
        }
        const state = {
          nodes: body.nodes,
          positions: body.positions && typeof body.positions === "object" ? body.positions : {},
          versions: Array.isArray(body.versions) ? body.versions : [],
          updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString(),
        };
        const changed = await writeStudioState(state);
        sendJson(response, 200, { saved: true, changed, updatedAt: state.updatedAt });
      } catch (error) {
        sendJson(response, 400, { error: error?.message ?? "invalid_request" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/sync/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sync/events") {
      const expectedToken = process.env.APS_SYNC_TOKEN;
      if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = await readBody(request);
        if (typeof body.content !== "string" || !body.content.trim()) {
          sendJson(response, 400, { error: "content_required" });
          return;
        }
        const event = {
          id: typeof body.id === "string" && body.id ? body.id : randomUUID(),
          source: body.source ?? "gpt",
          conversationId: body.conversationId,
          turnId: body.turnId,
          role: body.role ?? "assistant",
          content: body.content.trim(),
          confirmed: body.confirmed === true,
          operations: Array.isArray(body.operations) ? body.operations : [],
          receivedAt: new Date().toISOString(),
        };
        const events = await readEvents();
        if (!events.some((item) => item.id === event.id)) {
          events.push(event);
          await writeEvents(events);
          const message = `data: ${JSON.stringify(event)}\n\n`;
          clients.forEach((client) => client.write(message));
        }
        sendJson(response, 202, { accepted: true, eventId: event.id });
      } catch (error) {
        sendJson(response, error?.message === "payload_too_large" ? 413 : 400, { error: error?.message ?? "invalid_request" });
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

function syncApiPlugin() {
  return {
    name: "aps-local-sync-api",
    configureServer: attachSyncApi,
    configurePreviewServer: attachSyncApi,
  };
}

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.5",
    port: 8005,
    strictPort: true,
    allowedHosts: ["127.0.0.5", "localhost", "terminal.local"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  preview: {
    host: "127.0.0.5",
    port: 8005,
    strictPort: true,
  },
  plugins: [react(), syncApiPlugin()],
});
