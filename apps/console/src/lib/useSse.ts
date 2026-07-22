import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AmiEvent } from "@ami/shared";
import { publishIngestProgress } from "./ingest";

/** Subscribe to the server event stream and invalidate the relevant queries. */
export function useSse(onEvent?: (e: AmiEvent) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (msg) => {
      let e: AmiEvent;
      try {
        e = JSON.parse(msg.data);
      } catch {
        return;
      }
      onEvent?.(e);
      switch (e.type) {
        case "todo.created":
        case "todo.updated":
          void qc.invalidateQueries({ queryKey: ["todos"] });
          if ("todoId" in e) void qc.invalidateQueries({ queryKey: ["task", e.todoId] });
          break;
        case "run.status":
        case "step.appended":
        case "artifact.created":
          void qc.invalidateQueries({ queryKey: ["task", e.todoId] });
          break;
        case "draft.created":
        case "draft.updated":
          void qc.invalidateQueries({ queryKey: ["task", e.todoId] });
          void qc.invalidateQueries({ queryKey: ["todos"] });
          break;
        case "connector.status":
          void qc.invalidateQueries({ queryKey: ["connectors"] });
          break;
        case "connector.build":
          void qc.invalidateQueries({ queryKey: ["connectors"] });
          void qc.invalidateQueries({ queryKey: ["connectorBuilds"] });
          break;
        case "question.created":
        case "question.answered":
          void qc.invalidateQueries({ queryKey: ["questions"] });
          if ("todoId" in e && e.todoId) void qc.invalidateQueries({ queryKey: ["task", e.todoId] });
          if ("sessionId" in e && e.sessionId)
            void qc.invalidateQueries({ queryKey: ["chat", e.sessionId] });
          break;
        case "chat.delta":
        case "chat.done":
          void qc.invalidateQueries({ queryKey: ["chat", e.sessionId] });
          void qc.invalidateQueries({ queryKey: ["chatSessions"] });
          break;
        case "ingest.progress":
          if ("message" in e && typeof e.message === "string") publishIngestProgress(e.message);
          break;
        case "bgtask.updated":
          void qc.invalidateQueries({ queryKey: ["bgTasks"] });
          void qc.invalidateQueries({ queryKey: ["bgTask", e.slug] });
          break;
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
