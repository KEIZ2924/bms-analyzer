import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const port = Number(process.env.PORT) || 4173;
const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = normalize(join(root, relative));
    if (!target.startsWith(root)) {
        response.writeHead(403).end("forbidden");
        return;
    }
    try {
        const body = await readFile(target);
        response.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream" });
        response.end(body);
    } catch {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`BMS difficulty web: http://127.0.0.1:${port}/`);
});
