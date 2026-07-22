import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DraftDto } from "@ami/shared";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { CheckIcon } from "./icons";

/** The one editable draft card: nothing sends without the button. Shared by
 * the task page's draft panel and the chat-embedded draft. */
export function DraftEditor({ draft }: { draft: DraftDto }) {
  const qc = useQueryClient();
  const [body, setBody] = useState(draft.editedBody ?? draft.body);
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      if (body !== draft.body) await api.saveDraft(draft.id, body);
      const res = await api.sendDraft(draft.id);
      if (!res.ok) throw new Error(res.error ?? "send failed");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", draft.todoId] }),
    onError: (e: Error) => setError(errMsg(e)),
  });
  const discard = useMutation({
    mutationFn: () => api.discardDraft(draft.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", draft.todoId] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="card p-3">
      <div className="text-xs text-mut mb-2">
        → {draft.channel} · {draft.targetRef || "no target"}
      </div>
      <textarea
        className="input min-h-28 font-sans"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <div className="text-xs text-bad mt-1">{error}</div>}
      <div className="flex gap-2 mt-2">
        <button className="btn btn-primary" disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Sending…" : "Approve & send"}
        </button>
        <button className="btn" disabled={discard.isPending} onClick={() => discard.mutate()}>
          Discard
        </button>
      </div>
    </div>
  );
}

/** A draft living inside a chat thread: report_draft's recorded result carries
 * the ids, and the thread shows the same approve/edit/discard card in place.
 * SSE draft.* events invalidate the task query, so state changes land live. */
export function DraftEmbed({ todoId, draftId }: { todoId: string; draftId: string }) {
  const { data } = useQuery({ queryKey: ["task", todoId], queryFn: () => api.task(todoId) });
  const draft = data?.drafts.find((d) => d.id === draftId);
  if (!draft) return null;
  if (draft.status === "pending") {
    return (
      <div className="max-w-[92%] rise">
        <DraftEditor draft={draft} />
      </div>
    );
  }
  return (
    <div className="card p-3 text-sm text-mut max-w-[92%]">
      {draft.status === "sent" ? (
        <>
          <span className="text-ok mr-2 inline-flex items-center gap-1">
            <CheckIcon /> sent via {draft.channel}
          </span>
          {(draft.editedBody ?? draft.body).slice(0, 140)}
        </>
      ) : (
        <span>draft discarded</span>
      )}
    </div>
  );
}
