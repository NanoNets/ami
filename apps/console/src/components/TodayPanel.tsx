import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { Markdown } from "./Markdown";
import { ExternalIcon, Spinner } from "./icons";

/** Today's meetings with prep briefs, plus the local recorder controls. */

export function TodayPanel() {
  const { data: meetings = [] } = useQuery({
    queryKey: ["todayMeetings"],
    queryFn: api.todayMeetings,
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: recorder } = useQuery({
    queryKey: ["recorderStatus"],
    queryFn: api.recorderStatus,
    refetchInterval: (q) => (q.state.data?.recording ? 2_000 : 60_000),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const recorderReady =
    !!recorder && recorder.deps.ffmpeg && recorder.deps.whisper && recorder.deps.model;
  if (meetings.length === 0 && !recorderReady && !recorder?.recording) return null;

  // Prefill the recording title with whatever meeting is happening right now.
  const now = Date.now();
  const current = meetings.find((m) => {
    const start = new Date(m.start).getTime();
    const end = m.end ? new Date(m.end).getTime() : start + 3_600_000;
    return now >= start - 5 * 60_000 && now <= end;
  });

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Today ({meetings.length})</h2>
      {(recorderReady || recorder?.recording) && (
        <div className="flex justify-end mb-2">
          <RecorderControl status={recorder!} defaultTitle={current?.title} />
        </div>
      )}
      <div className="space-y-2">
        {meetings.map((m) => (
          <div key={m.id} className="card p-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-mut shrink-0 w-14">
                {new Date(m.start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="font-medium text-sm">{m.title}</span>
              <span className="flex gap-1.5 flex-wrap">
                {m.attendees.slice(0, 5).map((a, i) =>
                  a.noteFile ? (
                    <Link
                      key={i}
                      to={`/memory?note=${encodeURIComponent(a.noteFile)}`}
                      className="chip text-[10px] text-acc hover:underline"
                    >
                      {a.label}
                    </Link>
                  ) : (
                    <span key={i} className="chip text-[10px]">
                      {a.label}
                    </span>
                  ),
                )}
              </span>
              <span className="ml-auto flex gap-2 items-center">
                {m.joinLink && (
                  <a
                    href={m.joinLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-acc hover:underline inline-flex items-center gap-1"
                  >
                    join <ExternalIcon size={11} />
                  </a>
                )}
                {m.briefPath && (
                  <button className="btn text-xs" onClick={() => setOpenId(openId === m.id ? null : m.id)}>
                    {openId === m.id ? "Hide brief" : "Prep brief"}
                  </button>
                )}
              </span>
            </div>
            {openId === m.id && m.briefPath && <BriefBody path={m.briefPath} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function RecorderControl({
  status,
  defaultTitle,
}: {
  status: Awaited<ReturnType<typeof api.recorderStatus>>;
  defaultTitle?: string;
}) {
  const qc = useQueryClient();
  const rec = status.recording;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (rec?.status !== "recording") return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [rec?.status]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["recorderStatus"] });
  const start = useMutation({
    mutationFn: () => api.recorderStart(defaultTitle),
    onSettled: refresh,
    onError: (e) => toast.error(errMsg(e)),
  });
  const stop = useMutation({ mutationFn: api.recorderStop, onSettled: refresh });

  if (rec?.status === "recording") {
    const secs = Math.max(0, Math.floor((Date.now() - new Date(rec.startedAt).getTime()) / 1000));
    const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    return (
      <span className="flex items-center gap-2 text-xs">
        <span className="w-2 h-2 rounded-full bg-bad shrink-0" />
        <span className="text-mut truncate max-w-56">{rec.title}</span>
        <span className="text-mut tabular-nums">{elapsed}</span>
        <button className="btn text-xs" onClick={() => stop.mutate()} disabled={stop.isPending}>
          Stop
        </button>
      </span>
    );
  }
  if (rec?.status === "transcribing") {
    const p = status.transcribeProgress;
    return (
      <span className="text-xs text-mut inline-flex items-center gap-1.5">
        <Spinner /> Transcribing{p.total > 0 ? ` ${p.done}/${p.total}` : ""}…
      </span>
    );
  }
  return (
    <span className="flex items-center gap-3">
      {status.lastSession?.status === "error" && (
        <span className="text-xs text-bad" title={status.lastSession.error}>
          last recording failed
        </span>
      )}
      {status.lastSession?.status === "done" && status.lastSession.notePath && (
        <Link
          to={`/memory?note=${encodeURIComponent(status.lastSession.notePath)}`}
          className="text-xs text-acc hover:underline inline-flex items-center gap-1"
        >
          transcript <ExternalIcon size={11} />
        </Link>
      )}
      <button
        className="btn text-xs inline-flex items-center gap-1.5"
        onClick={() => start.mutate()}
        disabled={start.isPending}
        title={
          status.deps.systemAudioDevice
            ? `Records mic + system audio (${status.deps.systemAudioDevice}); transcribed on-device`
            : "Records the mic (room audio); transcribed on-device. System audio capture needs macOS 14.4+."
        }
      >
        <span className="w-2 h-2 rounded-full bg-bad inline-block" /> Record
        {defaultTitle ? ` — ${defaultTitle.slice(0, 32)}` : ""}
      </button>
    </span>
  );
}

function BriefBody({ path }: { path: string }) {
  const { data } = useQuery({ queryKey: ["memoryNote", path], queryFn: () => api.memoryNote(path) });
  if (!data) return <p className="text-xs text-mut mt-2">Loading brief…</p>;
  return (
    <div className="mt-3 border-t border-edge pt-3 bg-panel2 p-3 max-h-80 overflow-y-auto">
      <Markdown>{data.content.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, t, a) => a || String(t).split("/").pop() || t)}</Markdown>
    </div>
  );
}
