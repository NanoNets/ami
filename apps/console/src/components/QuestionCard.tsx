import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface PendingQuestion {
  id: string;
  kind: "question" | "permission";
  question: string;
  options: string[];
  createdAt: string;
}

/** An agent is blocked waiting for the user: render the question with option
 * buttons and a free-text answer. Used on task pages and in chat threads. */
export function QuestionCard({ q }: { q: PendingQuestion }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const answer = useMutation({
    mutationFn: (a: string) => api.answerQuestion(q.id, a),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["questions"] });
    },
  });

  return (
    <div className="border border-acc bg-panel2 p-4">
      <p className="text-xs uppercase tracking-wide text-acc mb-1.5">
        {q.kind === "permission" ? "ami needs permission" : "ami has a question"}
      </p>
      <p className="text-sm whitespace-pre-wrap">{q.question}</p>
      <div className="flex flex-wrap gap-2 mt-3">
        {q.options.map((opt) => (
          <button
            key={opt}
            className={`btn text-xs ${q.kind === "permission" && /^allow/i.test(opt) ? "btn-primary" : ""}`}
            disabled={answer.isPending}
            onClick={() => answer.mutate(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      {q.kind === "question" && (
        <div className="flex gap-2 mt-2">
          <input
            className="input h-8 text-sm"
            placeholder="Or type an answer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) answer.mutate(text.trim());
            }}
          />
          <button
            className="btn btn-primary text-xs shrink-0"
            disabled={!text.trim() || answer.isPending}
            onClick={() => answer.mutate(text.trim())}
          >
            Answer
          </button>
        </div>
      )}
    </div>
  );
}
