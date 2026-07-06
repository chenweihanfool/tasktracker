// End-to-end smoke test: spins up the fake Vikunja API (real recorded
// response shapes, see mock-vikunja.mjs), spawns the built MCP server
// pointed at it, and calls every tool through the real MCP client/stdio
// transport -- no real Replit credentials needed.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startMock() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "mock-vikunja.mjs"), [], {
      env: { ...process.env, MOCK_PORT: "0" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    child.on("message", (msg) => resolve({ child, port: msg.port }));
    child.on("error", reject);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

async function main() {
  const { child: mock, port } = await startMock();
  const baseUrl = `http://127.0.0.1:${port}`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "dist", "index.js")],
    env: {
      VIKUNJA_API_BASE_URL: baseUrl,
      VIKUNJA_API_TOKEN: "test-token",
      VIKUNJA_TIMEZONE: "UTC",
    },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  try {
    // list_projects
    let res = await client.callTool({ name: "list_projects", arguments: {} });
    assert(!res.isError, `list_projects failed: ${textOf(res)}`);
    const projects = JSON.parse(textOf(res));
    assert(projects.length === 2, `expected 2 projects, got ${projects.length}`);
    console.log("[PASS] list_projects");

    // list_tasks: project 1 has task 1 (parent) with subtask 2 nested
    res = await client.callTool({ name: "list_tasks", arguments: { project_id: 1 } });
    assert(!res.isError, `list_tasks failed: ${textOf(res)}`);
    const tree = JSON.parse(textOf(res));
    assert(tree.length === 1, `expected 1 root task, got ${tree.length}`);
    assert(tree[0].id === 1, "expected root task id 1");
    assert(tree[0].subtasks.length === 1 && tree[0].subtasks[0].id === 2, "expected task 1 to have subtask 2 nested");
    console.log("[PASS] list_tasks (tree nesting)");

    // create_task with due_date + priority, as a subtask of task 1
    res = await client.callTool({
      name: "create_task",
      arguments: {
        project_id: 1,
        title: "New subtask",
        parent_task_id: 1,
        due_date: "2026-07-10T00:00:00Z",
        priority: 3,
      },
    });
    assert(!res.isError, `create_task failed: ${textOf(res)}`);
    const created = JSON.parse(textOf(res));
    assert(created.due_date === "2026-07-10T00:00:00Z", "due_date not preserved exactly (timezone drift?)");
    console.log("[PASS] create_task (with parent_task_id + due_date)");

    // create_task should reject a due_date without an explicit UTC offset
    res = await client.callTool({
      name: "create_task",
      arguments: { project_id: 1, title: "Bad date", due_date: "2026-07-10" },
    });
    assert(res.isError, "create_task should reject a due_date without timezone info");
    console.log("[PASS] create_task rejects ambiguous due_date");

    // update_task: mark task 2 done, verify title survives (not wiped by partial update)
    res = await client.callTool({
      name: "update_task",
      arguments: { task_id: 2, done: true },
    });
    assert(!res.isError, `update_task failed: ${textOf(res)}`);
    const updated = JSON.parse(textOf(res));
    assert(updated.done === true, "done flag not applied");
    assert(updated.title === "TEST", "title was wiped by partial update");
    console.log("[PASS] update_task (partial update preserves other fields)");

    // get_overdue_tasks: task in the mock with a real due_date? none yet besides the
    // one we just created (due 2026-07-10, future) -- exercise the call path.
    res = await client.callTool({ name: "get_overdue_tasks", arguments: {} });
    assert(!res.isError, `get_overdue_tasks failed: ${textOf(res)}`);
    console.log("[PASS] get_overdue_tasks (call path)");

    res = await client.callTool({ name: "get_tasks_due_today", arguments: {} });
    assert(!res.isError, `get_tasks_due_today failed: ${textOf(res)}`);
    console.log("[PASS] get_tasks_due_today (call path)");

    // Error surfacing: wrong token should produce a clear, non-hallucinated error
    const badTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "dist", "index.js")],
      env: {
        VIKUNJA_API_BASE_URL: baseUrl,
        VIKUNJA_API_TOKEN: "wrong-token",
      },
    });
    const badClient = new Client({ name: "test-client-bad", version: "1.0.0" });
    await badClient.connect(badTransport);
    res = await badClient.callTool({ name: "list_projects", arguments: {} });
    assert(res.isError, "expected an error result for an invalid token");
    assert(textOf(res).includes("HTTP 401"), `expected HTTP 401 to be surfaced, got: ${textOf(res)}`);
    console.log("[PASS] invalid token surfaces a real HTTP 401, not a hallucinated result");
    await badClient.close();

    console.log("\nAll MCP server smoke tests passed.");
  } finally {
    await client.close();
    mock.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
