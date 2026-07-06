// Minimal fake Vikunja API used for local, credential-free testing of the
// MCP server. Response shapes are copied from real curl output captured
// against the live deployed instance (project 1 with a parent/subtask pair,
// project 2 with a lone task), not guessed.
import http from "node:http";

const projects = [
  { id: 1, title: "Inbox" },
  { id: 2, title: "prj" },
];

let nextTaskId = 100;
const tasksById = new Map();

function seedTask(id, overrides) {
  tasksById.set(id, {
    id,
    title: "TEST",
    description: "",
    done: false,
    due_date: "0001-01-01T00:00:00Z",
    priority: 0,
    project_id: 1,
    identifier: `#${id}`,
    related_tasks: {},
    ...overrides,
  });
}

seedTask(1, {
  related_tasks: { subtask: [{ id: 2, title: "TEST", related_tasks: null }] },
});
seedTask(2, {
  related_tasks: { parenttask: [{ id: 1, title: "TEST", related_tasks: null }] },
});
seedTask(3, { project_id: 2, title: "subprj" });

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const auth = req.headers.authorization;

  if (auth !== "Bearer test-token") {
    return send(res, 401, { message: "invalid token (mock)" });
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : undefined;

    // GET /api/v1/projects
    if (req.method === "GET" && url.pathname === "/api/v1/projects") {
      return send(res, 200, projects);
    }

    // GET /api/v1/projects/:id/tasks
    let m = url.pathname.match(/^\/api\/v1\/projects\/(\d+)\/tasks$/);
    if (req.method === "GET" && m) {
      const projectId = Number(m[1]);
      const page = Number(url.searchParams.get("page") || "1");
      if (page > 1) return send(res, 200, []); // no pagination needed for these fixtures
      const tasks = [...tasksById.values()].filter((t) => t.project_id === projectId);
      return send(res, 200, tasks);
    }

    // PUT /api/v1/projects/:id/tasks  (create)
    if (req.method === "PUT" && m) {
      const projectId = Number(m[1]);
      const id = nextTaskId++;
      const task = {
        id,
        title: json.title,
        description: "",
        done: false,
        due_date: json.due_date ?? "0001-01-01T00:00:00Z",
        priority: json.priority ?? 0,
        project_id: projectId,
        related_tasks: {},
      };
      tasksById.set(id, task);
      return send(res, 201, task);
    }

    // GET /api/v1/tasks/:id
    m = url.pathname.match(/^\/api\/v1\/tasks\/(\d+)$/);
    if (req.method === "GET" && m) {
      const task = tasksById.get(Number(m[1]));
      if (!task) return send(res, 404, { message: "task not found (mock)" });
      return send(res, 200, task);
    }

    // POST /api/v1/tasks/:id  (update)
    if (req.method === "POST" && m) {
      const id = Number(m[1]);
      if (!tasksById.has(id)) return send(res, 404, { message: "task not found (mock)" });
      const merged = { ...tasksById.get(id), ...json, id };
      tasksById.set(id, merged);
      return send(res, 200, merged);
    }

    // DELETE /api/v1/tasks/:id
    if (req.method === "DELETE" && m) {
      const id = Number(m[1]);
      if (!tasksById.has(id)) return send(res, 404, { message: "task not found (mock)" });
      tasksById.delete(id);
      return send(res, 200, { message: "task deleted (mock)" });
    }

    // PUT /api/v1/tasks/:id/relations
    m = url.pathname.match(/^\/api\/v1\/tasks\/(\d+)\/relations$/);
    if (req.method === "PUT" && m) {
      const parentId = Number(m[1]);
      if (!tasksById.has(parentId) || !tasksById.has(json.other_task_id)) {
        return send(res, 404, { message: "task not found (mock)" });
      }
      const parent = tasksById.get(parentId);
      const child = tasksById.get(json.other_task_id);
      parent.related_tasks = parent.related_tasks || {};
      parent.related_tasks[json.relation_kind] = [
        ...(parent.related_tasks[json.relation_kind] || []),
        { id: child.id, title: child.title, related_tasks: null },
      ];
      child.related_tasks = child.related_tasks || {};
      child.related_tasks.parenttask = [{ id: parent.id, title: parent.title, related_tasks: null }];
      return send(res, 200, {
        task_id: parentId,
        other_task_id: json.other_task_id,
        relation_kind: json.relation_kind,
      });
    }

    return send(res, 404, { message: `no mock route for ${req.method} ${url.pathname}` });
  });
});

const port = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 0;
server.listen(port, () => {
  console.error(`[mock-vikunja] listening on ${server.address().port}`);
  process.send?.({ port: server.address().port });
});
