import { eq } from "drizzle-orm";
import { newId, nowIso, type AmiEvent } from "@ami/shared";
import { questions, type Db } from "@ami/db";

type Publish = (e: AmiEvent) => void;

/** The human-input channel: agents (task runs, chat turns, the coding
 * permission broker) block on a question; the console answers it. One
 * mechanism for both open questions and permission asks. */

const pending = new Map<string, (answer: string) => void>();

export const NO_ANSWER = "(no answer from the user — proceed with your best judgment)";
export const PERMISSION_TIMEOUT_ANSWER = "deny";

export interface AskArgs {
  runId?: string | null;
  todoId?: string | null;
  sessionId?: string | null;
  kind: "question" | "permission";
  question: string;
  options?: string[];
  timeoutMs?: number;
}

export function askUser(db: Db, publish: Publish, args: AskArgs): Promise<string> {
  const id = newId("q");
  db.insert(questions)
    .values({
      id,
      runId: args.runId ?? null,
      todoId: args.todoId ?? null,
      sessionId: args.sessionId ?? null,
      kind: args.kind,
      question: args.question,
      optionsJson: args.options ? JSON.stringify(args.options) : null,
      status: "pending",
      createdAt: nowIso(),
    })
    .run();
  publish({
    type: "question.created",
    questionId: id,
    todoId: args.todoId ?? null,
    sessionId: args.sessionId ?? null,
  });

  const timeoutMs = args.timeoutMs ?? 15 * 60 * 1000;
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Fail closed for permissions, best-judgment for questions.
      const answer = args.kind === "permission" ? PERMISSION_TIMEOUT_ANSWER : NO_ANSWER;
      db.update(questions)
        .set({ status: "timeout", answer, answeredAt: nowIso() })
        .where(eq(questions.id, id))
        .run();
      publish({ type: "question.answered", questionId: id });
      resolve(answer);
    }, timeoutMs);
    pending.set(id, (answer) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(answer);
    });
  });
}

/** Called by the API when the user answers. Returns false when the question
 * is unknown or already resolved. */
export function answerQuestion(db: Db, publish: Publish, id: string, answer: string): boolean {
  const row = db.select().from(questions).where(eq(questions.id, id)).get();
  if (!row || row.status !== "pending") return false;
  db.update(questions)
    .set({ status: "answered", answer, answeredAt: nowIso() })
    .where(eq(questions.id, id))
    .run();
  publish({ type: "question.answered", questionId: id });
  const resolver = pending.get(id);
  if (resolver) resolver(answer);
  // No resolver (e.g. restart lost the awaiting agent) — the answer is still
  // recorded; the orphaned run was already failed by recovery.
  return true;
}

export function listPendingQuestions(db: Db) {
  return db.select().from(questions).where(eq(questions.status, "pending")).all();
}

export function questionsForTodo(db: Db, todoId: string) {
  return db.select().from(questions).where(eq(questions.todoId, todoId)).all();
}
