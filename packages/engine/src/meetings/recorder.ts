import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { amiHome, getSetting, openDb, type Db } from "@ami/db";
import { commitKnowledge, invalidateKnowledgeIndex, knowledgeDir } from "@ami/memory";
import type { AmiEvent } from "@ami/shared";
import { createEvent } from "../events/index.js";
import { audioTapSupported, ensureAudioTapBinary, spawnAudioTap } from "./audiotap.js";
import { processMeetingActionItems } from "./process.js";

type Publish = (e: AmiEvent) => void;

/** Local meeting recorder: fully offline capture + transcription.
 *
 * Capture: ffmpeg/avfoundation records the default mic, plus system audio —
 * the other side of the call, so segments can be labeled Me/Them. System
 * audio comes from the driverless Core Audio tap helper (macOS 14.4+, see
 * audiotap.ts), falling back to a BlackHole/loopback device when one exists.
 * Audio is written as 5-minute WAV segments so a crash mid-meeting loses at
 * most the last partial segment.
 *
 * Transcription: whisper.cpp (`brew install whisper-cpp`) with a ggml model
 * downloaded once into ~/.ami/models/. No network involved after that.
 *
 * Output joins the Granola pipeline: a markdown note in
 * knowledge/Meetings/local/ → action-item extraction → meeting.notes_ready
 * event → the note-creation agent absorbs it into dossiers. */

const SEGMENT_SEC = 300;
const MAX_RECORDING_MS = 3 * 60 * 60 * 1000;

/** Full large-v3: the most accurate whisper model, notably better than the
 * turbo variants on accented English. ~3.1 GB, downloaded once. */
const MODEL_FILE = "ggml-large-v3.bin";
const MODEL_SIZE_MB = 3100;
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

// ── Dependency discovery ─────────────────────────────────────────────────────

function findBin(...names: string[]): string | null {
  for (const name of names) {
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    try {
      const p = execFileSync("which", [name]).toString().trim();
      if (p) return p;
    } catch {
      // not on PATH
    }
  }
  return null;
}

const ffmpegBin = () => findBin("ffmpeg");
const whisperBin = () => findBin("whisper-cli", "whisper-cpp");

function modelsDir(): string {
  return path.join(amiHome(), "models");
}

/** Transcription language ("auto" or an ISO code like "en"). Pinning "en"
 * can help accented English when auto-detect misfires. */
function transcribeLanguage(): string {
  return getSetting(openDb(), "recorder_language") ?? "auto";
}

function modelPath(): string | null {
  const p = path.join(modelsDir(), MODEL_FILE);
  return fs.existsSync(p) ? p : null;
}

/** Parse `ffmpeg -list_devices` stderr for avfoundation audio devices. */
async function listAudioDevices(): Promise<{ index: number; name: string }[]> {
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) return [];
  const stderr = await new Promise<string>((resolve) => {
    execFile(
      ffmpeg,
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { timeout: 10_000 },
      (_err, _stdout, stderr) => resolve(String(stderr)),
    );
  });
  const devices: { index: number; name: string }[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    const m = inAudio ? line.match(/\[(\d+)\]\s+(.+?)\s*$/) : null;
    if (m) devices.push({ index: parseInt(m[1], 10), name: m[2] });
  }
  return devices;
}

function findLoopback(devices: { index: number; name: string }[]): { index: number; name: string } | null {
  return devices.find((d) => /blackhole|loopback/i.test(d.name)) ?? null;
}

// ── Model download ───────────────────────────────────────────────────────────

let modelDownload: { inProgress: boolean; receivedBytes: number; totalBytes: number; error?: string } = {
  inProgress: false,
  receivedBytes: 0,
  totalBytes: 0,
};

export function startModelDownload(): { ok: boolean; error?: string } {
  if (modelDownload.inProgress) return { ok: true };
  if (fs.existsSync(path.join(modelsDir(), MODEL_FILE))) return { ok: true };
  modelDownload = { inProgress: true, receivedBytes: 0, totalBytes: 0 };
  void (async () => {
    const dest = path.join(modelsDir(), MODEL_FILE);
    const part = `${dest}.part`;
    try {
      fs.mkdirSync(modelsDir(), { recursive: true });
      const res = await fetch(MODEL_URL);
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      modelDownload.totalBytes = parseInt(res.headers.get("content-length") ?? "0", 10);
      const out = fs.createWriteStream(part);
      for await (const chunk of res.body as any) {
        out.write(chunk);
        modelDownload.receivedBytes += (chunk as Buffer).length;
      }
      await new Promise<void>((resolve, reject) => out.end((e: any) => (e ? reject(e) : resolve())));
      fs.renameSync(part, dest);
      modelDownload.inProgress = false;
      console.log(`[recorder] whisper model downloaded (${Math.round(modelDownload.receivedBytes / 1e6)} MB)`);
    } catch (e: any) {
      fs.rmSync(part, { force: true });
      modelDownload = { inProgress: false, receivedBytes: 0, totalBytes: 0, error: String(e?.message ?? e) };
      console.error("[recorder] model download failed:", e);
    }
  })();
  return { ok: true };
}

// ── Session state ────────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;
  title: string;
  startedAt: string;
  status: "recording" | "transcribing" | "done" | "error";
  hasSystemAudio: boolean;
  error?: string;
  notePath?: string;
}

interface CaptureProc {
  proc: ChildProcess;
  stream: "mic" | "sys";
  /** Leaders get the SIGINT on stop; followers (ffmpeg fed from a pipe)
   * finalize on their own when the leader's stdout closes. */
  leader: boolean;
}

interface ActiveSession {
  meta: SessionMeta;
  dir: string;
  procs: CaptureProc[];
  stderrTail: string;
  watchdog: NodeJS.Timeout;
}

let active: ActiveSession | null = null;
let lastSession: SessionMeta | null = null;
let transcribeProgress = { done: 0, total: 0 };

function recordingsDir(): string {
  return path.join(amiHome(), "recordings");
}

function saveMeta(dir: string, meta: SessionMeta): void {
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export async function recorderStatus(): Promise<{
  deps: { ffmpeg: boolean; whisper: boolean; model: boolean; systemAudioDevice: string | null };
  modelSizeMb: number;
  language: string;
  modelDownload: { inProgress: boolean; receivedBytes: number; totalBytes: number; error?: string };
  recording: SessionMeta | null;
  lastSession: SessionMeta | null;
  transcribeProgress: { done: number; total: number };
}> {
  const devices = await listAudioDevices();
  return {
    deps: {
      ffmpeg: !!ffmpegBin(),
      whisper: !!whisperBin(),
      model: !!modelPath(),
      systemAudioDevice: audioTapSupported()
        ? "macOS audio tap (built-in)"
        : findLoopback(devices)?.name ?? null,
    },
    modelSizeMb: MODEL_SIZE_MB,
    language: transcribeLanguage(),
    modelDownload,
    recording: active?.meta ?? (lastSession?.status === "transcribing" ? lastSession : null),
    lastSession,
    transcribeProgress,
  };
}

// ── Capture ──────────────────────────────────────────────────────────────────

const SEGMENT_ARGS = [
  "-ac", "1",
  "-ar", "16000",
  "-c:a", "pcm_s16le",
  "-f", "segment",
  "-segment_time", String(SEGMENT_SEC),
  "-reset_timestamps", "1",
];

function spawnCapture(ffmpeg: string, device: string, outPattern: string): ChildProcess {
  return spawn(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", `:${device}`, ...SEGMENT_ARGS, outPattern],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/** System audio via the Core Audio tap helper: helper streams raw f32le PCM,
 * ffmpeg segments it. Returns both processes, or null when the tap isn't
 * available/permitted (callers fall back to loopback or mic-only). */
async function spawnTapCapture(ffmpeg: string, outPattern: string): Promise<CaptureProc[] | null> {
  const binary = await ensureAudioTapBinary();
  if (!binary) return null;
  const tap = await spawnAudioTap(binary);
  if (!tap.ok) {
    console.log(`[recorder] audio tap unavailable (${tap.error}) — falling back`);
    return null;
  }
  const seg = spawn(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "f32le", "-ar", String(tap.rate), "-ac", String(tap.channels), "-i", "pipe:0",
      ...SEGMENT_ARGS,
      outPattern,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  tap.proc.stdout!.pipe(seg.stdin!);
  seg.stdin!.on("error", () => {}); // EPIPE when ffmpeg exits first
  return [
    { proc: tap.proc, stream: "sys", leader: true },
    { proc: seg, stream: "sys", leader: false },
  ];
}

export async function startRecording(
  db: Db,
  publish: Publish,
  opts: { title?: string } = {},
): Promise<{ ok: boolean; error?: string; session?: SessionMeta }> {
  if (active) return { ok: false, error: "Already recording" };
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) return { ok: false, error: "ffmpeg not found — brew install ffmpeg" };
  if (!whisperBin()) return { ok: false, error: "whisper.cpp not found — brew install whisper-cpp" };
  if (!modelPath()) return { ok: false, error: "Whisper model not downloaded — see Settings → Local recorder" };

  const devices = await listAudioDevices();
  if (devices.length === 0) return { ok: false, error: "No audio input devices found (mic permission?)" };
  const loopback = findLoopback(devices);

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(recordingsDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  // System audio: driverless Core Audio tap first, loopback device second.
  const sysPattern = path.join(dir, "sys-%03d.wav");
  let sysProcs = await spawnTapCapture(ffmpeg, sysPattern);
  let sysLabel = sysProcs ? "audio tap" : null;
  if (!sysProcs && loopback) {
    sysProcs = [{ proc: spawnCapture(ffmpeg, loopback.name, sysPattern), stream: "sys", leader: true }];
    sysLabel = loopback.name;
  }

  const meta: SessionMeta = {
    id,
    title: opts.title?.trim() || `Meeting ${now.toISOString().slice(0, 16).replace("T", " ")}`,
    startedAt: now.toISOString(),
    status: "recording",
    hasSystemAudio: !!sysProcs,
  };
  saveMeta(dir, meta);

  const procs: CaptureProc[] = [
    { proc: spawnCapture(ffmpeg, "default", path.join(dir, "mic-%03d.wav")), stream: "mic", leader: true },
    ...(sysProcs ?? []),
  ];

  const session: ActiveSession = {
    meta,
    dir,
    procs,
    stderrTail: "",
    watchdog: setTimeout(() => {
      console.log("[recorder] watchdog: auto-stopping after 3h");
      void stopRecording(db, publish);
    }, MAX_RECORDING_MS),
  };
  active = session;

  for (const p of procs) {
    p.proc.stderr?.on("data", (d) => {
      session.stderrTail = (session.stderrTail + d.toString()).slice(-800);
    });
    p.proc.on("exit", (code) => {
      if (active !== session || session.meta.status !== "recording") return;
      if (code === 0 || code === 255 || code === null) return;
      if (p.stream === "sys") {
        // System-audio capture died (e.g. permission revoked mid-run): keep
        // the meeting — drop to mic-only rather than losing everything.
        console.error(`[recorder] system-audio capture died (exit ${code}) — continuing mic-only`);
        for (const other of session.procs) {
          if (other.stream === "sys" && other.proc.exitCode === null) other.proc.kill("SIGINT");
        }
        session.meta.hasSystemAudio = false;
        saveMeta(session.dir, session.meta);
        return;
      }
      // Mic death is fatal — fail the session so the console shows why.
      clearTimeout(session.watchdog);
      for (const other of session.procs) {
        if (other.proc.exitCode === null) other.proc.kill("SIGINT");
      }
      session.meta.status = "error";
      session.meta.error = `capture failed (ffmpeg exit ${code}): ${session.stderrTail.trim().slice(-300) || "no output — check microphone permission for the terminal running Ami"}`;
      saveMeta(session.dir, session.meta);
      lastSession = session.meta;
      active = null;
    });
  }

  console.log(`[recorder] recording "${meta.title}" (${sysLabel ? `mic + ${sysLabel}` : "mic only"})`);
  return { ok: true, session: meta };
}

export async function stopRecording(db: Db, publish: Publish): Promise<{ ok: boolean; error?: string }> {
  const session = active;
  if (!session) return { ok: false, error: "Not recording" };
  active = null;
  clearTimeout(session.watchdog);

  // SIGINT the leaders (ffmpeg finalizes the current segment's WAV header;
  // the tap helper closes its pipe, which ends its segmenter via EOF).
  for (const p of session.procs) {
    if (p.leader && p.proc.exitCode === null) p.proc.kill("SIGINT");
  }
  await Promise.all(
    session.procs.map(
      ({ proc }) =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null) return resolve();
          const t = setTimeout(() => {
            proc.kill("SIGKILL");
            resolve();
          }, 5000);
          proc.on("exit", () => {
            clearTimeout(t);
            resolve();
          });
        }),
    ),
  );

  session.meta.status = "transcribing";
  saveMeta(session.dir, session.meta);
  lastSession = session.meta;
  void finalizeSession(db, publish, session.dir, session.meta).catch((e) => {
    console.error("[recorder] finalize failed:", e);
  });
  return { ok: true };
}

// ── Transcription + finalize ─────────────────────────────────────────────────

async function transcribeWav(
  whisper: string,
  model: string,
  wav: string,
): Promise<{ fromMs: number; text: string }[]> {
  const prefix = wav.replace(/\.wav$/, "");
  await new Promise<void>((resolve, reject) => {
    execFile(
      whisper,
      // Beam search (-bs 5) over greedy: meaningfully better on accents and
      // crosstalk for a ~2x slowdown — still far faster than realtime on Metal.
      ["-m", model, "-f", wav, "-oj", "-of", prefix, "-np", "-bs", "5", "-l", transcribeLanguage()],
      { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  const parsed = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf-8"));
  return ((parsed.transcription ?? []) as any[])
    .map((s) => ({ fromMs: s.offsets?.from ?? 0, text: String(s.text ?? "").trim() }))
    .filter((s) => s.text.length > 0);
}

function segmentFiles(dir: string, stream: "mic" | "sys"): { file: string; offsetMs: number }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${stream}-`) && f.endsWith(".wav"))
    .sort()
    .map((f) => ({
      file: path.join(dir, f),
      offsetMs: parseInt(f.slice(stream.length + 1, -4), 10) * SEGMENT_SEC * 1000,
    }));
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderTranscript(
  utterances: { atMs: number; speaker: "Me" | "Them" | null; text: string }[],
): string {
  utterances.sort((a, b) => a.atMs - b.atMs);
  const paragraphs: string[] = [];
  let cur: { atMs: number; speaker: "Me" | "Them" | null; parts: string[] } | null = null;
  for (const u of utterances) {
    if (cur && cur.speaker === u.speaker && cur.parts.join(" ").length < 700) {
      cur.parts.push(u.text);
    } else {
      if (cur) {
        const label = cur.speaker ? `**${cur.speaker}:** ` : "";
        paragraphs.push(`\`[${fmtTime(cur.atMs)}]\` ${label}${cur.parts.join(" ")}`);
      }
      cur = { atMs: u.atMs, speaker: u.speaker, parts: [u.text] };
    }
  }
  if (cur) {
    const label = cur.speaker ? `**${cur.speaker}:** ` : "";
    paragraphs.push(`\`[${fmtTime(cur.atMs)}]\` ${label}${cur.parts.join(" ")}`);
  }
  return paragraphs.join("\n\n");
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/*?:"<>|]/g, "_").substring(0, 100).trim() || "untitled";
}

async function finalizeSession(db: Db, publish: Publish, dir: string, meta: SessionMeta): Promise<void> {
  const whisper = whisperBin();
  const model = modelPath();
  try {
    if (!whisper || !model) throw new Error("whisper.cpp or model missing at transcription time");

    const mic = segmentFiles(dir, "mic");
    const sys = meta.hasSystemAudio ? segmentFiles(dir, "sys") : [];
    if (mic.length === 0 && sys.length === 0) throw new Error("no audio captured");

    transcribeProgress = { done: 0, total: mic.length + sys.length };
    const utterances: { atMs: number; speaker: "Me" | "Them" | null; text: string }[] = [];
    for (const [stream, segs] of [["mic", mic], ["sys", sys]] as const) {
      // Only label speakers when we have both sides on separate streams;
      // a lone mic in a room hears everyone, so labels would be wrong.
      const speaker = sys.length > 0 ? (stream === "mic" ? "Me" : "Them") : null;
      for (const seg of segs) {
        try {
          for (const s of await transcribeWav(whisper, model, seg.file)) {
            utterances.push({ atMs: seg.offsetMs + s.fromMs, speaker, text: s.text });
          }
        } catch (e) {
          // A crash mid-recording can truncate the last segment — skip it.
          console.error(`[recorder] segment failed (skipping) ${seg.file}:`, e);
        }
        transcribeProgress.done++;
      }
    }
    if (utterances.length === 0) throw new Error("transcription produced no text (silent recording?)");

    const transcript = renderTranscript(utterances);
    const durationMin = Math.max(1, Math.round((utterances[utterances.length - 1].atMs + 30_000) / 60_000));
    const dateStr = meta.startedAt.slice(0, 10);
    const meetingsDir = path.join(knowledgeDir(), "Meetings", "local");
    fs.mkdirSync(meetingsDir, { recursive: true });
    const filePath = path.join(meetingsDir, `${dateStr} ${cleanFilename(meta.title)}.md`);

    let md = `---\n`;
    md += `source: local-recorder\n`;
    md += `title: ${JSON.stringify(meta.title)}\n`;
    md += `recorded_at: ${meta.startedAt}\n`;
    md += `duration_min: ${durationMin}\n`;
    md += `---\n\n`;
    md += `# Meeting: ${meta.title}\n\n`;
    md += `**When:** ${meta.startedAt}\n`;
    md += `**Source:** local recording (${meta.hasSystemAudio ? "mic + system audio" : "mic"}), transcribed on-device with Whisper\n\n`;
    md += `## Transcript\n\n${transcript}\n`;
    fs.writeFileSync(filePath, md, "utf-8");

    const relPath = path.relative(knowledgeDir(), filePath);
    meta.status = "done";
    meta.notePath = relPath;
    saveMeta(dir, meta);
    lastSession = meta;

    // Reclaim disk: audio is ~2 MB/min/stream and the transcript is what matters.
    for (const f of fs.readdirSync(dir)) {
      if (/^(mic|sys)-\d+\.(wav|json)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }

    invalidateKnowledgeIndex();
    await commitKnowledge("Local meeting recording").catch(() => {});
    publish({ type: "ingest.progress", message: `recorder: transcribed "${meta.title}" (${durationMin} min)` });
    console.log(`[recorder] "${meta.title}" → knowledge/${relPath}`);

    void processMeetingActionItems(db, publish, {
      title: meta.title,
      when: meta.startedAt,
      notePath: relPath,
    }).catch((e) => console.error("[recorder] action-item extraction failed:", e));
    createEvent({
      source: "local-recorder",
      type: "meeting.notes_ready",
      createdAt: new Date().toISOString(),
      payload: `# Meeting notes ready: ${meta.title}\n\nWhen: ${meta.startedAt}\nNote: knowledge/${relPath}\n\n${md.slice(0, 2000)}`,
    });
  } catch (e: any) {
    meta.status = "error";
    meta.error = String(e?.message ?? e);
    saveMeta(dir, meta);
    lastSession = meta;
    console.error(`[recorder] session ${meta.id} failed:`, e);
  } finally {
    transcribeProgress = { done: 0, total: 0 };
  }
}

/** One-shot transcription for voice chat: the browser posts whatever
 * container MediaRecorder produced (webm/opus, mp4, …); ffmpeg probes it by
 * content and normalizes to what whisper wants. */
export async function transcribeAudio(
  input: Buffer,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const ffmpeg = ffmpegBin();
  const whisper = whisperBin();
  const model = modelPath();
  if (!ffmpeg || !whisper || !model) {
    return { ok: false, error: "voice input needs the local recorder set up (Settings → Local recorder)" };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ami-voice-"));
  try {
    const src = path.join(work, "input.audio");
    const wav = path.join(work, "input.wav");
    fs.writeFileSync(src, input);
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg,
        ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
        { timeout: 60_000 },
        (e, _out, stderr) => (e ? reject(new Error(String(stderr || e.message))) : resolve()),
      );
    });
    const segments = await transcribeWav(whisper, model, wav);
    const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    return text ? { ok: true, text } : { ok: false, error: "no speech detected" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Startup crash recovery: a server restart kills ffmpeg mid-meeting, but all
 * closed segments on disk are valid — transcribe what we have. */
export function recoverRecordings(db: Db, publish: Publish): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(recordingsDir());
  } catch {
    return;
  }
  for (const id of entries) {
    const dir = path.join(recordingsDir(), id);
    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    } catch {
      continue;
    }
    if (meta.status !== "recording" && meta.status !== "transcribing") continue;
    console.log(`[recorder] recovering orphaned session ${meta.id} (${meta.status})`);
    meta.status = "transcribing";
    saveMeta(dir, meta);
    lastSession = meta;
    void finalizeSession(db, publish, dir, meta).catch((e) =>
      console.error("[recorder] recovery failed:", e),
    );
  }
}
