// Loads the page in a real (headless) browser over CDP, waits until the sl/st
// cell stops showing the pending ellipsis, then prints the row text.
//
//   node tools/check-ui.mjs [url]

import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2] || "http://127.0.0.1:4173/?sample=1&open=1";
const port = 9333;

const browser = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=" + `${process.env.TEMP}\\bms-web-cdp`,
    "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const list = await response.json();
            const page = list.find((item) => item.type === "page");
            if (page) return page;
        } catch {
            // browser still starting
        }
        await sleep(250);
    }
    throw new Error("devtools never came up");
}

const page = await targets();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
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
await send("Page.navigate", { url });
await sleep(1500);

const readRow = async () => {
    const result = await send("Runtime.evaluate", {
        expression: `document.querySelector("#results tbody tr")?.innerText.replace(/\\s+/g, " ") ?? "no row"`,
        returnByValue: true,
    });
    return result.result?.result?.value;
};

let text = "";
for (let i = 0; i < 60; i++) {
    text = await readRow();
    if (text && !text.includes("…")) break;
    await sleep(500);
}

const detail = await send("Runtime.evaluate", {
    expression: `document.querySelector("#detail")?.hidden ? "(hidden)" : document.querySelector("#detailValues")?.innerText.replace(/\\s+/g, " ")`,
    returnByValue: true,
});

console.log("row:", text);
console.log("detail:", detail.result?.result?.value);

socket.close();
browser.kill();
