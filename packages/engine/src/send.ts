import { eq } from "drizzle-orm";
import {
  connectorAccounts,
  getDraft,
  getTodo,
  insertTrace,
  listDraftsForTodo,
  updateDraft,
  updateTodo,
  type Db,
} from "@ami/db";
import { getConnector } from "@ami/connectors";
import type { AmiEvent, AuthBlob } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** Approve & send a draft through its connector's send action. */
export async function sendDraft(db: Db, publish: Publish, draftId: string): Promise<void> {
  const draft = getDraft(db, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status === "sent") return;

  const connector = getConnector(draft.channel);
  if (!connector) throw new Error(`unknown connector ${draft.channel}`);
  const sendAction = connector.actions.find((a) => a.isSend);
  if (!sendAction) throw new Error(`connector ${draft.channel} has no send action`);

  const acct = db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.connector, draft.channel))
    .get();
  const auth: AuthBlob = acct ? JSON.parse(acct.authJson) : {};

  const body = draft.editedBody ?? draft.body;
  const result = await sendAction.run(auth, { targetRef: draft.targetRef, body });
  if (!result.ok) {
    throw new Error(result.error ?? "send failed");
  }

  updateDraft(db, draftId, {
    status: "sent",
    sentAt: new Date().toISOString(),
    sentExternalId: result.externalId,
  });

  // Edited drafts are a style/decision signal.
  if (draft.editedBody && draft.editedBody !== draft.body) {
    insertTrace(db, {
      todoId: draft.todoId,
      runId: draft.runId,
      kind: "draft_edit",
      situation: `Ami drafted: ${draft.body.slice(0, 200)}`,
      decision: `User edited to: ${draft.editedBody.slice(0, 200)}`,
      rationale: "learn phrasing/tone difference for future drafts",
    });
  }
  publish({ type: "draft.updated", draftId, todoId: draft.todoId });

  // Sending the reply is the review: once no pending drafts remain on a todo
  // that finished its run, the task is done — resolve it instead of leaving it
  // stuck in awaiting_review.
  const todo = getTodo(db, draft.todoId);
  if (todo?.status === "awaiting_review") {
    const stillPending = listDraftsForTodo(db, draft.todoId).some(
      (d) => d.id !== draftId && d.status === "pending",
    );
    if (!stillPending) {
      updateTodo(db, draft.todoId, { status: "resolved" });
      insertTrace(db, {
        todoId: draft.todoId,
        runId: draft.runId,
        kind: "resolution",
        situation: `Task: ${todo.title}`,
        decision: "user approved and sent the reply — task resolved",
      });
      publish({ type: "todo.updated", todoId: draft.todoId });
    }
  }
}
