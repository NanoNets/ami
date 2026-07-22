import { Hono } from "hono";
import type { Db } from "@ami/db";
import { publish } from "../sse.js";

/** Local meeting recorder: capture via ffmpeg, transcription via whisper.cpp —
 * no API involved. The console polls /status while recording/transcribing. */
export function recorderRoutes(db: Db) {
  const app = new Hono();

  app.get("/status", async (c) => {
    const { recorderStatus } = await import("@ami/engine");
    return c.json(await recorderStatus());
  });

  app.post("/start", async (c) => {
    const { startRecording } = await import("@ami/engine");
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const res = await startRecording(db, publish, { title: body.title });
    return c.json(res, res.ok ? 200 : 400);
  });

  app.post("/stop", async (c) => {
    const { stopRecording } = await import("@ami/engine");
    const res = await stopRecording(db, publish);
    return c.json(res, res.ok ? 200 : 400);
  });

  /** Voice chat: transcribe a browser-recorded utterance (raw audio body). */
  app.post("/transcribe", async (c) => {
    const { transcribeAudio } = await import("@ami/engine");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length < 1_000) return c.json({ ok: false, error: "empty audio" }, 400);
    const res = await transcribeAudio(buf);
    return c.json(res, res.ok ? 200 : 400);
  });

  /** One-time whisper model download (large-v3, ~3.1 GB, to ~/.ami/models/). */
  app.post("/model", async (c) => {
    const { startModelDownload } = await import("@ami/engine");
    return c.json(startModelDownload());
  });

  /** Transcription config: language pin ("auto" or an ISO code). */
  app.post("/config", async (c) => {
    const { setSetting } = await import("@ami/db");
    const body = await c.req.json<{ language?: string }>();
    if (body.language) setSetting(db, "recorder_language", body.language);
    return c.json({ ok: true });
  });

  return app;
}
