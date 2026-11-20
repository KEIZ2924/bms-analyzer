// Reproduces the file picker path: attaches a chart to the hidden <input> with CDP
// and reads the table afterwards.  This is the flow the drop zone cannot test.
//
//   node tools/check-pick.mjs <chart.bms> [url]

import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const chart = process.argv[2];
const url = process.argv[3] || "http://127.0.0.1:4173/";
const port = 9335;

if (!chart) {
    console.error("usage: node tools/check-pick.mjs <chart.bms> [url]");
    process.exit(2);
}

const profile = `${process.env.TEMP}\\bms-web-pick-${Date.now()}`;
const browser = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1200,800",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find((item) => item.type === "page");
            if (page) return page;
        } catch {
            // still starting
        }
        await sleep(250);
    }
    throw new Error("devtools never came up");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));

let nextId = 1;
const pending = new Map();
const logs = [];
socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
        logs.push(`exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description || ""}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        logs.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
    }
});

function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
}

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Network.enable");

// BLOCK_WORKER=1 exercises the main-thread fallback the way an older browser would.
if (process.env.BLOCK_WORKER) {
    await send("Network.setBlockedURLs", { urls: ["*ratingWorker.js"] });
}

await send("Page.navigate", { url });
await sleep(2000);

const document = await send("DOM.getDocument", { depth: 1 });
const input = await send("DOM.querySelector", { nodeId: document.result.root.nodeId, selector: "#files" });
await send("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [chart] });
await sleep(500);
await send("Runtime.evaluate", {
    expression: `document.getElementById("files").dispatchEvent(new Event("change"))`,
});

const read = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

for (let i = 0; i < 40; i++) {
    const count = await read(`document.querySelectorAll("#results tbody tr").length`);
    const pending = await read(`document.querySelector("#results tbody tr .slst")?.textContent`);
    if (count > 0 && pending && !pending.includes("…")) break;
    await sleep(500);
}

console.log("rows:", await read(`document.querySelectorAll("#results tbody tr").length`));
console.log("hidden:", await read(`document.getElementById("results").hidden`));
console.log("status:", await read(`document.getElementById("status").textContent`));
console.log("first row:", await read(`document.querySelector("#results tbody tr")?.innerText.replace(/\\s+/g, " ") ?? "none"`));
if (logs.length) console.log("errors:", logs);

socket.close();
browser.kill();
