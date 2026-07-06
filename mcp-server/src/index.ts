#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VikunjaApiError, VikunjaClient, VikunjaTask } from "./vikunja-client.js";
import { getTodayBoundsUTC, hasDueDate } from "./time.js";

const BASE_URL = process.env.VIKUNJA_API_BASE_URL;
const API_TOKEN = process.env.VIKUNJA_API_TOKEN;
const TIMEZONE = process.env.VIKUNJA_TIMEZONE || "UTC";

if (!BASE_URL || !API_TOKEN) {
  console.error(
    "[vikunja-mcp] ERROR: VIKUNJA_API_BASE_URL and VIKUNJA_API_TOKEN must both be set as environment variables.",
  );
  process.exit(1);
}

const client = new VikunjaClient(BASE_URL.replace(/\/$/, ""), API_TOKEN);

// Vikunja due_date must be an explicit-UTC ISO 8601 string. Rejecting bare
// dates / offset-less strings here is what keeps due_date free of timezone
// drift end-to-end (see docs/api-testing.md).
const isoUtcDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    "must be an ISO 8601 UTC datetime ending in Z, e.g. 2026-07-10T00:00:00Z",
  );

const priority = z.number().int().min(0).max(5);

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  if (err instanceof VikunjaApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Vikunja API error (HTTP ${err.status || "network"}) on ${err.path}: ${err.message}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

interface TaskTreeNode extends VikunjaTask {
  subtasks: TaskTreeNode[];
}

function buildTaskTree(tasks: VikunjaTask[]): TaskTreeNode[] {
  const byId = new Map<number, TaskTreeNode>();
  for (const t of tasks) {
    byId.set(t.id, { ...t, subtasks: [] });
  }
  const roots: TaskTreeNode[] = [];
  for (const t of tasks) {
    const node = byId.get(t.id)!;
    const parentRel = t.related_tasks?.parenttask;
    const parentId = parentRel && parentRel.length > 0 ? parentRel[0].id : undefined;
    const parentNode = parentId !== undefined ? byId.get(parentId) : undefined;
    if (parentNode) {
      parentNode.subtasks.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const server = new McpServer({ name: "vikunja-mcp-server", version: "1.0.0" });

server.registerTool(
  "list_projects",
  { description: "List all Vikunja projects accessible to the configured account." },
  async () => {
    try {
      return ok(await client.listProjects());
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_tasks",
  {
    description:
      "List all tasks in a Vikunja project as a tree, nesting subtasks under their parent task.",
    inputSchema: {
      project_id: z.number().int().describe("The Vikunja project ID."),
    },
  },
  async ({ project_id }) => {
    try {
      const tasks = await client.listTasksInProject(project_id);
      return ok(buildTaskTree(tasks));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "create_task",
  {
    description:
      "Create a new task in a Vikunja project, optionally as a subtask of an existing task.",
    inputSchema: {
      project_id: z.number().int().describe("The Vikunja project ID to create the task in."),
      title: z.string().min(1),
      parent_task_id: z
        .number()
        .int()
        .optional()
        .describe("If set, the new task is created as a subtask of this task ID."),
      due_date: isoUtcDateTime.optional(),
      priority: priority.optional().describe("0=unset,1=low,2=medium,3=high,4=urgent,5=do now"),
    },
  },
  async ({ project_id, title, parent_task_id, due_date, priority: p }) => {
    try {
      const fields: { title: string; due_date?: string; priority?: number } = { title };
      if (due_date !== undefined) fields.due_date = due_date;
      if (p !== undefined) fields.priority = p;

      const task = await client.createTask(project_id, fields);

      if (parent_task_id !== undefined) {
        try {
          await client.createRelation(parent_task_id, "subtask", task.id);
        } catch (relErr) {
          // The task itself was created successfully; say so explicitly and
          // report the relation failure separately instead of hiding it.
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Task ${task.id} ("${title}") was created, but linking it as a subtask of ` +
                  `task ${parent_task_id} failed: ${
                    relErr instanceof VikunjaApiError
                      ? `HTTP ${relErr.status}: ${relErr.message}`
                      : String(relErr)
                  }`,
              },
            ],
          };
        }
      }

      return ok(task);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "update_task",
  {
    description:
      "Update fields on an existing Vikunja task (title, description, done status, due date, priority). Only the fields you pass are changed.",
    inputSchema: {
      task_id: z.number().int(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      done: z.boolean().optional().describe("Mark the task as completed (true) or not (false)."),
      due_date: isoUtcDateTime.optional(),
      priority: priority.optional(),
    },
  },
  async ({ task_id, ...rawFields }) => {
    try {
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawFields)) {
        if (value !== undefined) updates[key] = value;
      }
      if (Object.keys(updates).length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "update_task was called with no fields to update." }],
        };
      }

      // Vikunja's update endpoint expects the full task object; fetch the
      // current state first so fields we're not touching aren't cleared out.
      const current = await client.getTask(task_id);
      const merged = { ...current, ...updates };
      const updated = await client.updateTask(task_id, merged);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  },
);

async function collectMatchingTasks(predicate: (t: VikunjaTask) => boolean): Promise<VikunjaTask[]> {
  const projects = await client.listProjects();
  const matches: VikunjaTask[] = [];
  for (const project of projects) {
    const tasks = await client.listTasksInProject(project.id);
    for (const task of tasks) {
      if (task.done) continue;
      if (!hasDueDate(task)) continue;
      if (predicate(task)) matches.push(task);
    }
  }
  return matches;
}

server.registerTool(
  "get_tasks_due_today",
  {
    description:
      "List all incomplete tasks (across all projects) whose due date falls within today, evaluated in the server's configured timezone (VIKUNJA_TIMEZONE, default UTC).",
  },
  async () => {
    try {
      const { startUTC, endUTC } = getTodayBoundsUTC(TIMEZONE);
      const matches = await collectMatchingTasks((t) => {
        const due = new Date(t.due_date);
        return due >= startUTC && due < endUTC;
      });
      return ok(matches);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_overdue_tasks",
  {
    description:
      "List all incomplete tasks (across all projects) whose due date is before today, evaluated in the server's configured timezone (VIKUNJA_TIMEZONE, default UTC).",
  },
  async () => {
    try {
      const { startUTC } = getTodayBoundsUTC(TIMEZONE);
      const matches = await collectMatchingTasks((t) => new Date(t.due_date) < startUTC);
      return ok(matches);
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[vikunja-mcp] Connected. Talking to ${BASE_URL} (timezone: ${TIMEZONE}).`);
