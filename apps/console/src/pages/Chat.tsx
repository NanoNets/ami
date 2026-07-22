import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { timeAgo } from "../lib/time";
import { toast, errMsg } from "../lib/toast";
import { Markdown } from "../components/Markdown";
import { QuestionCard } from "../components/QuestionCard";
import { RunEmbed } from "../components/RunEmbed";
import { DraftEmbed } from "../components/DraftCard";
import { ChevronIcon, MicIcon, SparkIcon, SpeakerIcon, Spinner, StopIcon, XIcon } from "../components/icons";

/** Copilot chat: persistent, resumable sessions with Ami's full tool surface.
 * Streaming arrives via SSE query invalidation (chat.delta). The page owns the
 * viewport: sidebar and thread scroll independently, composer stays pinned. */

export default function Chat() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: sessions = [], isLoading } = useQuery({ queryKey: ["chatSessions"], queryFn: api.chatSessions });

  // Leaving a conversation (switching sessions or leaving the page) is when
  // its facts should land in memory — ping the routing agent, fire-and-forget.
  const lastSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastSessionRef.current && lastSessionRef.current !== sessionId) {
      void api.routeMemoryNotes().catch(() => {});
    }
    lastSessionRef.current = sessionId;
  }, [sessionId]);
  useEffect(
    () => () => {
      if (lastSessionRef.current) void api.routeMemoryNotes().catch(() => {});
    },
    [],
  );

  const newSession = useMutation({
    mutationFn: api.newChatSession,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["chatSessions"] });
      navigate(`/chat/${res.id}`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveChatSession(id),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: ["chatSessions"] });
      if (id === sessionId) navigate("/chat");
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    // 118px ≈ sticky header + main's vertical padding; the page never double-scrolls.
    <div className="flex gap-5" style={{ height: "calc(100vh - 118px)" }}>
      <aside className="w-56 shrink-0 flex flex-col min-h-0">
        <button className="btn btn-primary w-full mb-3 shrink-0" onClick={() => newSession.mutate()}>
          New chat
        </button>
        <div className="space-y-1 overflow-y-auto min-h-0">
          {isLoading &&
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="px-2.5 py-2" aria-hidden>
                <div className="h-3 w-3/4 bg-panel2" />
                <div className="h-2 w-1/3 bg-panel2 mt-1.5" />
              </div>
            ))}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center border transition-colors ${
                s.id === sessionId ? "border-acc bg-panel2" : "border-transparent"
              }`}
            >
              <button
                onClick={() => navigate(`/chat/${s.id}`)}
                className={`flex-1 min-w-0 text-left px-2.5 py-2 text-sm cursor-pointer ${
                  s.id === sessionId ? "text-hi" : "text-mut hover:text-hi"
                }`}
              >
                <span className="block truncate">{s.title ?? "New conversation"}</span>
                <span className="block text-[10px] text-mut">{timeAgo(s.updatedAt)}</span>
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-mut hover:text-hi px-1.5 shrink-0 cursor-pointer"
                title="Archive conversation"
                aria-label={`Archive "${s.title ?? "New conversation"}"`}
                onClick={() => archive.mutate(s.id)}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      </aside>
      {sessionId ? (
        <Thread sessionId={sessionId} />
      ) : (
        <div className="flex-1 card p-12 text-center text-mut self-start">
          <p className="mb-2">Talk to ami. It can search your memory, read your tools, draft replies,</p>
          <p>create to-dos, and kick off background agents. It never ships or sends anything without your approval.</p>
        </div>
      )}
    </div>
  );
}

/* ---------- assistant turn blocks: consecutive tool calls collapse to one line ---------- */

type Block = { kind: string; label?: string; text?: string; input?: string; result?: string; isError?: boolean };
type ToolCall = { label: string; input?: string; result?: string; isError?: boolean };
type Grouped =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolCall[] }
  | { kind: "run"; todoId: string; runId: string }
  | { kind: "draft"; todoId: string; draftId: string };

/** A start_todo call means a task run now belongs to this conversation — its
 * recorded input/result carry the ids, and the thread embeds the live run. */
function runFromBlock(b: Block): Grouped | null {
  if (b.label !== "start_todo" || !b.input || !b.result || b.isError) return null;
  try {
    const input = JSON.parse(b.input) as { todoId?: string };
    const result = JSON.parse(b.result) as { runId?: string };
    if (input.todoId && result.runId) return { kind: "run", todoId: input.todoId, runId: result.runId };
  } catch {
    /* older turns may hold truncated details — no embed, no harm */
  }
  return null;
}

/** A report_draft call means an outbound reply is waiting for approval — the
 * thread embeds the same edit/approve/discard card the task page shows. */
function draftFromBlock(b: Block): Grouped | null {
  if (b.label !== "report_draft" || !b.result || b.isError) return null;
  try {
    const result = JSON.parse(b.result) as { draftId?: string; todoId?: string };
    if (result.draftId && result.todoId) return { kind: "draft", todoId: result.todoId, draftId: result.draftId };
  } catch {
    /* older turns may hold truncated details — no embed, no harm */
  }
  return null;
}

function groupBlocks(blocks: Block[]): Grouped[] {
  const out: Grouped[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_use") {
      const call: ToolCall = { label: b.label ?? "tool", input: b.input, result: b.result, isError: b.isError };
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.tools.push(call);
      else out.push({ kind: "tools", tools: [call] });
      const embed = runFromBlock(b) ?? draftFromBlock(b);
      if (embed) out.push(embed);
    } else if (b.text) {
      out.push({ kind: "text", text: b.text });
    }
  }
  return out;
}

/** Three quiet dots: ami is working right now. The only looping motion in the
 * thread — it disappears the moment content lands. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 px-0.5 py-1" aria-label="ami is thinking">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}

/** One quiet line per run of tool calls, closed by default. Expanding tells
 * the real story: each call with what went in and what came back. */
function ToolGroup({ tools }: { tools: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const failed = tools.filter((t) => t.isError).length;
  const summary = tools.length === 1 ? tools[0].label : `${tools[0].label} +${tools.length - 1} more`;
  return (
    <div>
      <button
        className="inline-flex items-center gap-1.5 text-xs text-mut hover:text-hi cursor-pointer"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SparkIcon size={12} />
        <span className="truncate max-w-72">{summary}</span>
        {failed > 0 && <span className="text-bad shrink-0">({failed} failed)</span>}
        <ChevronIcon size={11} open={open} />
      </button>
      {open && (
        <div className="mt-1.5 border-l-2 border-edge pl-3 space-y-1 rise">
          {tools.map((t, i) => (
            <ToolCallRow key={i} call={t} defaultOpen={tools.length === 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single call: label line, then its details on demand. Single-call groups
 * skip the second click and show details right away. */
function ToolCallRow({ call, defaultOpen = false }: { call: ToolCall; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = !!(call.input || call.result);
  return (
    <div className="text-xs">
      <button
        className={`inline-flex items-center gap-1.5 cursor-pointer ${call.isError ? "text-bad" : "text-mut"} ${hasDetail ? "hover:text-hi" : "cursor-default"}`}
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`w-1 h-1 rounded-full shrink-0 ${call.isError ? "bg-bad" : "bg-edge2"}`} />
        <span className="truncate max-w-80 text-left">{call.label}</span>
        {call.isError && <span className="shrink-0">failed</span>}
        {hasDetail ? <ChevronIcon size={10} open={open} /> : <span className="text-mut/50">— no details recorded</span>}
      </button>
      {open && hasDetail && (
        <div className="mt-1 mb-2 space-y-1.5 rise">
          {call.input && (
            <div>
              <span className="block text-[10px] uppercase tracking-wide text-mut/70 mb-0.5">input</span>
              <pre className="bg-panel2 border border-edge rounded-soft p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {call.input}
              </pre>
            </div>
          )}
          {call.result && (
            <div>
              <span className="block text-[10px] uppercase tracking-wide text-mut/70 mb-0.5">
                {call.isError ? "error" : "result"}
              </span>
              <pre
                className={`border rounded-soft p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto ${
                  call.isError ? "bg-bad/5 border-bad/30 text-bad" : "bg-panel2 border-edge"
                }`}
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Thread({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: ["chat", sessionId],
    queryFn: () => api.chatSession(sessionId),
    refetchInterval: (q) =>
      q.state.data?.turns.some((t) => t.content.running) ? 1500 : false,
  });
  const { data: pendingQuestions = [] } = useQuery({ queryKey: ["questions"], queryFn: api.questions });
  const chatQuestions = pendingQuestions.filter((q) => q.sessionId === sessionId);
  const [text, setText] = useState("");
  const [voiceMode, setVoiceMode] = useState(() => localStorage.getItem("ami-voice-mode") === "1");
  const bottomRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const running = data?.turns.some((t) => t.content.running) ?? false;

  const send = useMutation({
    mutationFn: (t: string) => api.sendChatMessage(sessionId, t),
    // The message appears in the thread the instant you hit Enter; the server
    // round-trip happens behind it. On failure the text returns to the composer.
    onMutate: (t) => {
      setText("");
      qc.setQueryData<Awaited<ReturnType<typeof api.chatSession>>>(["chat", sessionId], (prev) =>
        prev
          ? {
              ...prev,
              turns: [
                ...prev.turns,
                {
                  id: `pending-${Date.now()}`,
                  seq: (prev.turns[prev.turns.length - 1]?.seq ?? 0) + 1,
                  role: "user" as const,
                  content: { text: t },
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat", sessionId] });
      void qc.invalidateQueries({ queryKey: ["chatSessions"] });
    },
    onError: (e, t) => {
      setText(t);
      void qc.invalidateQueries({ queryKey: ["chat", sessionId] });
      toast.error(errMsg(e));
    },
  });

  // A message handed over from the homepage AskBar (router state) fires as
  // soon as the thread mounts — the user is already looking at the chat.
  const location = useLocation();
  const navigate = useNavigate();
  const handedOff = useRef(false);
  useEffect(() => {
    const pending = (location.state as { pending?: string } | null)?.pending;
    if (pending && !handedOff.current) {
      handedOff.current = true;
      send.mutate(pending);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stop = useMutation({
    mutationFn: () => api.stopChat(sessionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["chat", sessionId] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  // Voice input: in voice mode a transcript sends immediately (hands-free);
  // otherwise it lands in the composer for editing. Ref so the MediaRecorder
  // callback always sees the current state.
  const onTranscriptRef = useRef<(t: string) => void>(() => {});
  onTranscriptRef.current = (t) => {
    if (voiceMode && !running && !send.isPending) send.mutate(t);
    else setText((prev) => (prev ? prev.trimEnd() + " " : "") + t);
  };
  const voice = useVoiceInput((t) => onTranscriptRef.current(t));
  useEffect(() => {
    if (voice.error) toast.error(`voice: ${voice.error}`);
  }, [voice.error]);

  // Voice mode speaks finished assistant turns. Turns that existed when the
  // session opened (or arrived with voice mode off) are marked as already
  // spoken so history never plays back.
  const spokenRef = useRef<Set<string>>(new Set());
  const spokenInitRef = useRef<string | null>(null);
  useEffect(() => {
    const turns = data?.turns ?? [];
    if (!data) return;
    if (spokenInitRef.current !== sessionId) {
      spokenInitRef.current = sessionId;
      spokenRef.current = new Set(turns.map((t) => t.id));
      return;
    }
    if (!voiceMode) {
      for (const t of turns) spokenRef.current.add(t.id);
      return;
    }
    const last = turns[turns.length - 1];
    if (!last || last.role !== "assistant" || last.content.running || spokenRef.current.has(last.id)) return;
    spokenRef.current.add(last.id);
    const spoken = (last.content.blocks ?? [])
      .filter((b) => b.kind === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    if (spoken) speak(spoken);
  }, [data, sessionId, voiceMode]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.turns.length, running]);

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex-1 space-y-4 overflow-y-auto pb-4 min-h-0">
        {(data?.turns ?? []).map((t) => (
          <div key={t.id} className={t.role === "user" ? "flex justify-end rise" : "rise"}>
            {t.role === "user" ? (
              <div className="bg-panel2 border border-edge rounded-soft px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap">
                {t.content.text}
              </div>
            ) : (
              <div className="max-w-[92%] space-y-2">
                {groupBlocks(t.content.blocks ?? []).map((g, i) =>
                  g.kind === "tools" ? (
                    <ToolGroup key={i} tools={g.tools} />
                  ) : g.kind === "run" ? (
                    <RunEmbed key={i} todoId={g.todoId} runId={g.runId} />
                  ) : g.kind === "draft" ? (
                    <DraftEmbed key={i} todoId={g.todoId} draftId={g.draftId} />
                  ) : (
                    <div key={i} className="text-sm">
                      <Markdown>{g.text}</Markdown>
                    </div>
                  ),
                )}
                {t.content.running && <TypingDots />}
              </div>
            )}
          </div>
        ))}
        {/* the beat between sending and the assistant turn arriving */}
        {send.isPending && !running && (
          <div className="rise">
            <TypingDots />
          </div>
        )}
        {chatQuestions.map((q) => (
          <QuestionCard key={q.id} q={q} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 pt-3 border-t border-edge shrink-0">
        <textarea
          className="input h-16"
          placeholder={
            voice.state === "recording"
              ? "Listening…"
              : "Message ami… (Enter to send, Shift+Enter for newline)"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim() && !running) send.mutate(text.trim());
            }
          }}
        />
        <div className="flex flex-col gap-1.5 self-end shrink-0">
          <div className="flex gap-1.5 justify-end">
            <button
              className={`btn text-xs px-2 ${voiceMode ? "btn-primary" : ""}`}
              title="Voice mode: transcripts send hands-free and replies are spoken aloud"
              aria-label="Toggle voice mode"
              aria-pressed={voiceMode}
              onClick={() => {
                const next = !voiceMode;
                setVoiceMode(next);
                localStorage.setItem("ami-voice-mode", next ? "1" : "0");
                if (!next) window.speechSynthesis?.cancel();
              }}
            >
              <SpeakerIcon />
            </button>
            <button
              className="btn text-xs px-2"
              disabled={voice.state === "transcribing"}
              title={voice.state === "recording" ? "Stop and transcribe" : "Speak instead of typing (transcribed on-device)"}
              aria-label={voice.state === "recording" ? "Stop recording" : "Start voice input"}
              onClick={() => (voice.state === "recording" ? voice.stop() : void voice.start())}
            >
              {voice.state === "recording" ? (
                <span className="text-bad inline-flex items-center gap-1 tabular-nums">
                  <StopIcon size={12} /> {Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, "0")}
                </span>
              ) : voice.state === "transcribing" ? (
                <Spinner />
              ) : (
                <MicIcon />
              )}
            </button>
          </div>
          {running ? (
            <button
              className="btn rise inline-flex items-center justify-center gap-1.5 text-bad border-bad/40"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
              title="Stop this response — partial output stays in the thread"
            >
              <StopIcon size={12} /> {stop.isPending ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!text.trim() || send.isPending}
              onClick={() => send.mutate(text.trim())}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- voice: on-device STT (whisper via the recorder) + local TTS ---------- */

function useVoiceInput(onTranscript: (text: string) => void) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const start = async () => {
    if (recRef.current?.state === "recording") return;
    setError(null);
    window.speechSynthesis?.cancel(); // barge-in: talking interrupts Ami
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        try {
          const res = await api.transcribeVoice(new Blob(chunks, { type: rec.mimeType }));
          if (res.ok && res.text) onTranscript(res.text);
          else setError(res.error ?? "transcription failed");
        } catch (e) {
          setError(errMsg(e));
        } finally {
          setState("idle");
        }
      };
      recRef.current = rec;
      rec.start();
      setState("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };
  const stop = () => {
    if (recRef.current?.state === "recording") recRef.current.stop();
  };
  return { state, error, seconds, start, stop };
}

/** Local TTS via the browser's speech synthesis (on-device voices on macOS). */
function speak(markdown: string) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(stripForSpeech(markdown).slice(0, 2400));
  u.rate = 1.05;
  synth.speak(u);
}

function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " — code block omitted — ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, t, a) => a || String(t).split("/").pop() || t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[*_>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
