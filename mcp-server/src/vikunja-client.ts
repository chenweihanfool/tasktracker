// Thin wrapper around Vikunja's REST API. Every method either resolves with
// parsed JSON or rejects with a VikunjaApiError carrying the real HTTP status
// and the server's own error message -- callers must surface this to the
// agent verbatim instead of guessing what happened.

export class VikunjaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "VikunjaApiError";
  }
}

export interface VikunjaProject {
  id: number;
  title: string;
  [key: string]: unknown;
}

export interface VikunjaTask {
  id: number;
  title: string;
  description?: string;
  done: boolean;
  due_date: string;
  priority: number;
  project_id: number;
  identifier?: string;
  related_tasks?: Record<string, VikunjaTask[]>;
  [key: string]: unknown;
}

export interface VikunjaComment {
  id: number;
  comment: string;
  author?: { id: number; username: string; name?: string; [key: string]: unknown };
  created: string;
  updated: string;
  [key: string]: unknown;
}

const DEFAULT_PAGE_SIZE = 50;

export class VikunjaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new VikunjaApiError(
        0,
        path,
        `Network error calling Vikunja API at ${url}: ${(err as Error).message}`,
      );
    }

    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      const message =
        parsed && typeof parsed === "object" && "message" in (parsed as Record<string, unknown>)
          ? String((parsed as Record<string, unknown>).message)
          : text || res.statusText;
      throw new VikunjaApiError(res.status, path, message);
    }

    return parsed as T;
  }

  listProjects(): Promise<VikunjaProject[]> {
    return this.request<VikunjaProject[]>("GET", "/api/v1/projects");
  }

  createProject(fields: {
    title: string;
    description?: string;
    parent_project_id?: number;
  }): Promise<VikunjaProject> {
    return this.request<VikunjaProject>("PUT", "/api/v1/projects", fields);
  }

  async listTasksInProject(projectId: number): Promise<VikunjaTask[]> {
    const all: VikunjaTask[] = [];
    for (let page = 1; ; page++) {
      const pageTasks = await this.request<VikunjaTask[]>(
        "GET",
        `/api/v1/projects/${projectId}/tasks?page=${page}&per_page=${DEFAULT_PAGE_SIZE}`,
      );
      if (!pageTasks || pageTasks.length === 0) break;
      all.push(...pageTasks);
      if (pageTasks.length < DEFAULT_PAGE_SIZE) break;
    }
    return all;
  }

  getTask(id: number): Promise<VikunjaTask> {
    return this.request<VikunjaTask>("GET", `/api/v1/tasks/${id}`);
  }

  // Comments come back oldest-first by default (Vikunja's own `order_by`
  // param defaults to "asc"); we don't override it so callers see the
  // conversation in the order it happened.
  listTaskComments(id: number): Promise<VikunjaComment[]> {
    return this.request<VikunjaComment[]>("GET", `/api/v1/tasks/${id}/comments`);
  }

  createTask(
    projectId: number,
    fields: { title: string; due_date?: string; priority?: number },
  ): Promise<VikunjaTask> {
    return this.request<VikunjaTask>("PUT", `/api/v1/projects/${projectId}/tasks`, fields);
  }

  updateTask(id: number, fullTask: Record<string, unknown>): Promise<VikunjaTask> {
    return this.request<VikunjaTask>("POST", `/api/v1/tasks/${id}`, fullTask);
  }

  deleteTask(id: number): Promise<unknown> {
    return this.request("DELETE", `/api/v1/tasks/${id}`);
  }

  async setTaskColor(id: number, hexColor: string): Promise<VikunjaTask> {
    const current = await this.getTask(id);
    return this.updateTask(id, { ...current, hex_color: hexColor });
  }

  createRelation(taskId: number, relationKind: string, otherTaskId: number): Promise<unknown> {
    return this.request("PUT", `/api/v1/tasks/${taskId}/relations`, {
      relation_kind: relationKind,
      other_task_id: otherTaskId,
    });
  }
}
