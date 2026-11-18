import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PUBLIC_INDEX_PATH = path.join(PUBLIC_DIR, "index.html");
const PUBLIC_LOGO_PATH = path.join(PUBLIC_DIR, "morrales-logo.svg");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname.startsWith("/api/")) {
    await handleApiRequest(req, res);
    return;
  }

  if ((req.method ?? "GET") === "GET" && url.pathname === "/") {
    if (!fs.existsSync(PUBLIC_INDEX_PATH)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing public/index.html");
      return;
    }
    const html = fs.readFileSync(PUBLIC_INDEX_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if ((req.method ?? "GET") === "GET" && url.pathname === "/morrales-logo.svg") {
    if (!fs.existsSync(PUBLIC_LOGO_PATH)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing public/morrales-logo.svg");
      return;
    }
    const svg = fs.readFileSync(PUBLIC_LOGO_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(svg);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT?.trim() || "3000");

server.listen(port, host, () => {
  console.log(`Morrales Launchpad & Bridge running at http://${host}:${port}`);
});
