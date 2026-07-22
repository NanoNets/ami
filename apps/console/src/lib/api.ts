import type {
  ArtifactDto,
  ConnectorStatusDto,
  DraftDto,
  MemoryGraphDto,
  TaskRunDto,
  TaskStepDto,
  TodoDto,
  UsageSummaryDto,
} from "@ami/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  setupStatus: () =>
    fetch("/api/setup/status").then(
      json<{ hasApiKey: boolean; onboarded: boolean; model: string; kgModel: string; baseUrl: string }>,
    ),
  completeSetup: () =>
    fetch("/api/setup/complete", { method: "POST" }).then(json<{ ok: boolean }>),
  saveApiKey: (apiKey: string) =>
    fetch("/api/setup/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }).then(json<{ ok: boolean; error?: string }>),
  saveModel: (model: string) =>
    fetch("/api/setup/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).then(json<{ ok: boolean }>),
  saveKgModel: (model: string) =>
    fetch("/api/setup/kgmodel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }).then(json<{ ok: boolean }>),
  saveBaseUrl: (baseUrl: string) =>
    fetch("/api/setup/baseurl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl }),
    }).then(json<{ ok: boolean; error?: string }>),

  connectors: () =>
    fetch("/api/connectors").then(
      json<
        (ConnectorStatusDto & {
          authFields: { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }[];
          /** One-click setup openers; {field} placeholders resolve from typed auth fields. */
          setupActions: { label: string; url: string }[];
        })[]
      >,
    ),
  connect: (id: string, auth: Record<string, string>) =>
    fetch(`/api/connectors/${id}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(auth),
    }).then(json<{ ok: boolean; error?: string; authUrl?: string; accountLabel?: string }>),
  disconnect: (id: string) => fetch(`/api/connectors/${id}/disconnect`, { method: "POST" }).then(json),
  slackChannels: () =>
    fetch("/api/connectors/slack/channels").then(
      json<{
        channels: { id: string; name: string; isPrivate: boolean; topic: string }[];
        privateUnavailable: boolean;
        readAllIds: string[];
        readDms: boolean;
        error?: string;
      }>,
    ),
  saveSlackChannels: (readAll: { id: string; name: string }[], readDms: boolean) =>
    fetch("/api/connectors/slack/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readAll, readDms }),
    }).then(json<{ ok: boolean; count: number }>),
  buildConnector: (args: { name: string; homepage: string; usage: string }) =>
    fetch("/api/connectors/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }).then(json<{ ok: boolean; id?: string; error?: string }>),
  connectorBuilds: () =>
    fetch("/api/connectors/custom/builds").then(
      json<
        { id: string; name: string; status: "running" | "succeeded" | "failed"; message?: string; startedAt: string }[]
      >,
    ),
  deleteCustomConnector: (id: string) =>
    fetch(`/api/connectors/custom/${id}`, { method: "DELETE" }).then(json<{ ok: boolean }>),

  todos: () => fetch("/api/todos").then(json<TodoDto[]>),
  todoAction: (
    id: string,
    action: "plan" | "start" | "resolve" | "dismiss" | "snooze",
    context?: string,
    opts?: { projectId?: string; policy?: string },
  ) =>
    fetch(`/api/todos/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(context?.trim() ? { context } : {}), ...(opts ?? {}) }),
    }).then(json<{ runId?: string }>),
  // Undo for dismiss/snooze: puts the todo back on the list.
  reopenTodo: (id: string) =>
    fetch(`/api/todos/${id}/reopen`, { method: "POST" }).then(json<{ ok: boolean }>),
  setTodoDue: (id: string, dueAt: string | null) =>
    fetch(`/api/todos/${id}/due`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dueAt }),
    }).then(json<{ ok: boolean; dueAt: string | null }>),
  savePlan: (id: string, planMd: string) =>
    fetch(`/api/todos/${id}/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planMd }),
    }).then(json<{ ok: boolean }>),

  todayMeetings: () =>
    fetch("/api/meetings/today").then(
      json<
        {
          id: string;
          title: string;
          start: string;
          end?: string;
          joinLink?: string;
          attendees: { label: string; noteFile: string | null }[];
          matchedCount: number;
          briefPath: string | null;
        }[]
      >,
    ),

  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then(
      json<{ type: "knowledge" | "chat" | "task" | "signal"; title: string; preview: string; ref: string }[]>,
    ),

  chatSessions: () =>
    fetch("/api/chat/sessions").then(
      json<{ id: string; title: string | null; createdAt: string; updatedAt: string }[]>,
    ),
  newChatSession: () => fetch("/api/chat/sessions", { method: "POST" }).then(json<{ id: string }>),
  chatSession: (id: string) =>
    fetch(`/api/chat/sessions/${id}`).then(
      json<{
        id: string;
        turns: {
          id: string;
          seq: number;
          role: "user" | "assistant";
          content: {
            text?: string;
            blocks?: {
              kind: string;
              label?: string;
              text?: string;
              input?: string;
              result?: string;
              isError?: boolean;
            }[];
            running?: boolean;
          };
          createdAt: string;
        }[];
      }>,
    ),
  sendChatMessage: (id: string, text: string) =>
    fetch(`/api/chat/sessions/${id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<{ ok: boolean; error?: string }>),
  archiveChatSession: (id: string) =>
    fetch(`/api/chat/sessions/${id}/archive`, { method: "POST" }).then(json),
  stopChat: (id: string) =>
    fetch(`/api/chat/sessions/${id}/stop`, { method: "POST" }).then(json<{ ok: boolean }>),

  bgTasks: () =>
    fetch("/api/agents").then(
      json<
        {
          slug: string;
          name: string;
          instructions: string;
          active: boolean;
          triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
          projectId?: string;
          lastRunAt?: string;
          lastRunSummary?: string;
          lastRunError?: string;
        }[]
      >,
    ),
  bgTask: (slug: string) =>
    fetch(`/api/agents/${slug}`).then(
      json<{
        slug: string;
        name: string;
        instructions: string;
        active: boolean;
        triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
        projectId?: string;
        lastRunAt?: string;
        lastRunSummary?: string;
        lastRunError?: string;
        indexMd: string;
        runs: { id: string; status: string; error: string | null; startedAt: string | null; finishedAt: string | null; steps: TaskStepDto[] }[];
      }>,
    ),
  createBgTask: (body: unknown) =>
    fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ ok: boolean; slug?: string; error?: string }>),
  updateBgTask: (slug: string, body: unknown) =>
    fetch(`/api/agents/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ ok: boolean }>),
  runBgTask: (slug: string) => fetch(`/api/agents/${slug}/run`, { method: "POST" }).then(json),
  deleteBgTask: (slug: string) => fetch(`/api/agents/${slug}`, { method: "DELETE" }).then(json),

  liveNotes: () =>
    fetch("/api/agents/live-notes").then(
      json<
        {
          file: string;
          title: string;
          body: string;
          live: {
            objective: string;
            active?: boolean;
            triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
            lastRunAt?: string;
            lastRunId?: string;
            lastRunSummary?: string;
            lastRunError?: string;
          };
        }[]
      >,
    ),
  liveNoteRuns: (file: string) =>
    fetch(`/api/agents/live-notes/runs?file=${encodeURIComponent(file)}`).then(
      json<{
        runs: { id: string; status: string; error: string | null; startedAt: string | null; finishedAt: string | null; steps: TaskStepDto[] }[];
      }>,
    ),
  createLiveNote: (body: unknown) =>
    fetch("/api/agents/live-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ ok: boolean; file?: string; error?: string }>),
  updateLiveNote: (body: unknown) =>
    fetch("/api/agents/live-notes/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ ok: boolean }>),
  runLiveNote: (file: string) =>
    fetch("/api/agents/live-notes/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    }).then(json),
  deleteLiveNote: (file: string) =>
    fetch("/api/agents/live-notes/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    }).then(json),

  projects: () =>
    fetch("/api/projects").then(
      json<{ id: string; name: string; path: string; defaultBranch: string }[]>,
    ),
  addProject: (path: string, name?: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    }).then(json<{ ok: boolean; error?: string; project?: { id: string; name: string } }>),
  removeProject: (id: string) => fetch(`/api/projects/${id}`, { method: "DELETE" }).then(json),
  mergeBack: (projectId: string, branch: string) =>
    fetch(`/api/projects/${projectId}/merge-back`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    }).then(json<{ ok: boolean; message: string }>),
  planFeedback: (id: string, text: string) =>
    fetch(`/api/todos/${id}/plan/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json),
  planApprove: (id: string) => fetch(`/api/todos/${id}/plan/approve`, { method: "POST" }).then(json),

  task: (todoId: string) =>
    fetch(`/api/tasks/${todoId}`).then(
      json<{ runs: TaskRunDto[]; steps: TaskStepDto[]; artifacts: ArtifactDto[]; drafts: DraftDto[] }>,
    ),
  taskFeedback: (todoId: string, text: string) =>
    fetch(`/api/tasks/${todoId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json),
  cancelRun: (runId: string) => fetch(`/api/tasks/runs/${runId}/cancel`, { method: "POST" }).then(json),

  saveDraft: (id: string, editedBody: string) =>
    fetch(`/api/drafts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editedBody }),
    }).then(json),
  sendDraft: (id: string) =>
    fetch(`/api/drafts/${id}/send`, { method: "POST" }).then(json<{ ok: boolean; error?: string }>),
  discardDraft: (id: string) => fetch(`/api/drafts/${id}/discard`, { method: "POST" }).then(json),

  memoryGraph: () => fetch("/api/memory/graph").then(json<MemoryGraphDto>),
  // Fire-and-forget: route fresh chat facts into the knowledge base now.
  routeMemoryNotes: () => fetch("/api/memory/route-notes", { method: "POST" }).then(json<{ ok: boolean }>),
  memorySearch: (q: string) =>
    fetch(`/api/memory/search?q=${encodeURIComponent(q)}`).then(
      json<{ file: string; name: string; folder: string; score: number; excerpt: string }[]>,
    ),
  memoryNote: (path: string) =>
    fetch(`/api/memory/note?path=${encodeURIComponent(path)}`).then(json<{ path: string; content: string }>),
  noteHistory: (path: string) =>
    fetch(`/api/memory/note-history?path=${encodeURIComponent(path)}`).then(
      json<{ oid: string; message: string; timestamp: number; author: string }[]>,
    ),
  memoryHistory: (limit = 20) =>
    // Timeout so a wedged connection surfaces as a retryable error instead of
    // an infinite "Loading updates…" panel.
    fetch(`/api/memory/history?limit=${limit}`, { signal: AbortSignal.timeout(15000) }).then(
      json<{ oid: string; message: string; timestamp: number; author: string; files: string[] }[]>,
    ),
  noteAt: (path: string, oid: string) =>
    fetch(`/api/memory/note-at?path=${encodeURIComponent(path)}&oid=${oid}`).then(
      json<{ path: string; oid: string; content: string }>,
    ),
  noteRestore: (path: string, oid: string) =>
    fetch("/api/memory/note-restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, oid }),
    }).then(json<{ ok: boolean }>),
  suggestedTopics: () => fetch("/api/memory/suggested-topics").then(json<{ content: string }>),
  usage: () => fetch("/api/memory/usage").then(json<UsageSummaryDto[]>),

  questions: () =>
    fetch("/api/questions?status=pending").then(
      json<
        {
          id: string;
          runId: string | null;
          todoId: string | null;
          sessionId: string | null;
          kind: "question" | "permission";
          question: string;
          options: string[];
          createdAt: string;
        }[]
      >,
    ),
  answerQuestion: (id: string, answer: string) =>
    fetch(`/api/questions/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    }).then(json<{ ok: boolean }>),

  recorderStatus: () =>
    fetch("/api/recorder/status").then(
      json<{
        deps: { ffmpeg: boolean; whisper: boolean; model: boolean; systemAudioDevice: string | null };
        modelSizeMb: number;
        language: string;
        modelDownload: { inProgress: boolean; receivedBytes: number; totalBytes: number; error?: string };
        recording: {
          id: string;
          title: string;
          startedAt: string;
          status: "recording" | "transcribing" | "done" | "error";
          hasSystemAudio: boolean;
          error?: string;
          notePath?: string;
        } | null;
        lastSession: {
          id: string;
          title: string;
          startedAt: string;
          status: "recording" | "transcribing" | "done" | "error";
          hasSystemAudio: boolean;
          error?: string;
          notePath?: string;
        } | null;
        transcribeProgress: { done: number; total: number };
      }>,
    ),
  recorderStart: (title?: string) =>
    fetch("/api/recorder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).then(json<{ ok: boolean; error?: string }>),
  recorderStop: () =>
    fetch("/api/recorder/stop", { method: "POST" }).then(json<{ ok: boolean; error?: string }>),
  recorderDownloadModel: () =>
    fetch("/api/recorder/model", { method: "POST" }).then(json<{ ok: boolean; error?: string }>),
  recorderConfig: (cfg: { language?: string }) =>
    fetch("/api/recorder/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }).then(json<{ ok: boolean }>),
  transcribeVoice: (blob: Blob) =>
    fetch("/api/recorder/transcribe", { method: "POST", body: blob }).then(
      json<{ ok: boolean; text?: string; error?: string }>,
    ),

  granolaStatus: () =>
    fetch("/api/setup/granola").then(json<{ available: boolean; enabled: boolean }>),
  setGranola: (enabled: boolean) =>
    fetch("/api/setup/granola", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).then(json<{ ok: boolean }>),

  identity: () =>
    fetch("/api/setup/identity").then(json<{ name: string; email: string; domain: string }>),
  saveIdentity: (identity: { name?: string; email?: string; domain?: string }) =>
    fetch("/api/setup/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    }).then(json<{ ok: boolean }>),
};
