import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { amiHome } from "@ami/db";

/** Driverless system-audio capture for the local recorder.
 *
 * macOS 14.4+ exposes Core Audio process taps: a tiny Swift helper (compiled
 * once into ~/.ami/bin/ with the swiftc that ships in the Xcode CLT — already
 * required for better-sqlite3) streams everything the Mac plays as raw f32le
 * PCM on stdout. No BlackHole or any other driver to install; the only user
 * interaction is a one-time "System Audio Recording" permission prompt. */

const SWIFT_SOURCE = `// ami-audiotap: stream macOS system audio (a Core Audio process tap over all
// processes) to stdout as raw PCM. Prints "FORMAT rate=<hz> channels=<n>" to
// stderr once capture is running; samples are f32le. Requires macOS 14.4+.
import AudioToolbox
import CoreAudio
import Foundation

// Exit cleanly on signals no matter what state Core Audio is in — the system
// destroys private taps/aggregates when the process dies.
signal(SIGINT) { _ in _exit(0) }
signal(SIGTERM) { _ in _exit(0) }

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("ERROR " + msg + "\\n").data(using: .utf8)!)
    exit(1)
}

guard #available(macOS 14.4, *) else { fail("requires macOS 14.4+") }

// Default output device UID — the aggregate needs it as its clock source.
var outAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var outputID = AudioDeviceID(kAudioObjectUnknown)
var size = UInt32(MemoryLayout<AudioDeviceID>.size)
var err = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &outAddr, 0, nil, &size, &outputID)
guard err == noErr, outputID != kAudioObjectUnknown else { fail("no default output device (\\(err))") }

var uidAddr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var outputUID: CFString = "" as CFString
size = UInt32(MemoryLayout<CFString>.size)
err = withUnsafeMutablePointer(to: &outputUID) { ptr in
    AudioObjectGetPropertyData(outputID, &uidAddr, 0, nil, &size, ptr)
}
guard err == noErr else { fail("output device UID read failed (\\(err))") }

let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.name = "ami-audiotap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
err = AudioHardwareCreateProcessTap(tapDesc, &tapID)
guard err == noErr, tapID != kAudioObjectUnknown else {
    fail("tap create failed (\\(err)) — is System Audio Recording permission granted?")
}

var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var asbd = AudioStreamBasicDescription()
size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
err = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &size, &asbd)
guard err == noErr else { fail("tap format read failed (\\(err))") }
guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 else { fail("unexpected tap sample format") }

// Non-interleaved buffers: we emit only the first channel (mono is all
// transcription needs); interleaved: emit as-is and report the channel count.
let interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
let outChannels = interleaved ? Int(asbd.mChannelsPerFrame) : 1

let aggUID = UUID().uuidString
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "ami-audiotap",
    kAudioAggregateDeviceUIDKey as String: aggUID,
    kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outputUID]
    ],
    kAudioAggregateDeviceTapListKey as String: [
        [
            kAudioSubTapUIDKey as String: tapDesc.uuid.uuidString,
            kAudioSubTapDriftCompensationKey as String: true,
        ]
    ],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
err = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard err == noErr else { fail("aggregate device create failed (\\(err))") }

var procID: AudioDeviceIOProcID?
err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { _, inInputData, _, _, _ in
    let bufs = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    if bufs.count > 0, let data = bufs[0].mData, bufs[0].mDataByteSize > 0 {
        _ = write(1, data, Int(bufs[0].mDataByteSize))
    }
}
guard err == noErr else { fail("io proc create failed (\\(err))") }
err = AudioDeviceStart(aggID, procID)
guard err == noErr else { fail("device start failed (\\(err)) — is System Audio Recording permission granted?") }

FileHandle.standardError.write(
    "FORMAT rate=\\(Int(asbd.mSampleRate)) channels=\\(outChannels)\\n".data(using: .utf8)!)

dispatchMain()
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>sh.ami.audiotap</string>
	<key>CFBundleName</key>
	<string>ami-audiotap</string>
	<key>NSAudioCaptureUsageDescription</key>
	<string>Ami records system audio during meetings so the other side of the call can be transcribed on-device.</string>
</dict>
</plist>
`;

function swiftcPath(): string | null {
  return fs.existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : null;
}

/** macOS 14.4 = Darwin 23.4 — the first release with process-tap aggregates. */
function darwinSupportsTap(): boolean {
  if (process.platform !== "darwin") return false;
  const [major, minor] = os.release().split(".").map((n) => parseInt(n, 10));
  return major > 23 || (major === 23 && minor >= 4);
}

function binaryPath(): string {
  const hash = createHash("sha256").update(SWIFT_SOURCE).digest("hex").slice(0, 8);
  return path.join(amiHome(), "bin", `ami-audiotap-${hash}`);
}

/** Cheap availability check for status displays — no compilation. */
export function audioTapSupported(): boolean {
  return darwinSupportsTap() && (fs.existsSync(binaryPath()) || !!swiftcPath());
}

let compiling: Promise<string | null> | null = null;

/** Compile-on-first-use, cached by source hash so upgrades recompile. */
export function ensureAudioTapBinary(): Promise<string | null> {
  const dest = binaryPath();
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (!darwinSupportsTap()) return Promise.resolve(null);
  const swiftc = swiftcPath();
  if (!swiftc) return Promise.resolve(null);
  if (compiling) return compiling;
  compiling = (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ami-audiotap-"));
    try {
      const src = path.join(work, "audiotap.swift");
      const plist = path.join(work, "Info.plist");
      fs.writeFileSync(src, SWIFT_SOURCE);
      fs.writeFileSync(plist, INFO_PLIST);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile(
          swiftc,
          ["-O", "-o", dest, src,
            "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist],
          { timeout: 120_000 },
          (err, _stdout, stderr) => (err ? reject(new Error(`swiftc: ${stderr || err.message}`)) : resolve()),
        );
      });
      // Stale binaries from older source versions.
      for (const f of fs.readdirSync(path.dirname(dest))) {
        if (f.startsWith("ami-audiotap-") && f !== path.basename(dest)) {
          fs.rmSync(path.join(path.dirname(dest), f), { force: true });
        }
      }
      console.log("[recorder] compiled audio-tap helper →", dest);
      return dest;
    } catch (e) {
      console.error("[recorder] audio-tap compile failed:", e);
      return null;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      compiling = null;
    }
  })();
  return compiling;
}

export type AudioTapHandle =
  | { ok: true; proc: ChildProcess; rate: number; channels: number }
  | { ok: false; error: string };

/** Spawn the helper and wait for its FORMAT handshake (which it only prints
 * once capture is actually running). A pending permission prompt shows up as
 * a timeout here — the caller falls back to loopback/mic-only. */
export function spawnAudioTap(binary: string): Promise<AudioTapHandle> {
  const proc = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (res: AudioTapHandle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!res.ok) proc.kill("SIGKILL");
      resolve(res);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "audio tap start timed out (System Audio Recording permission pending?)" }),
      15_000,
    );
    proc.stderr!.on("data", (d: Buffer) => {
      buf = (buf + d.toString()).slice(-2000);
      const fmt = buf.match(/FORMAT rate=(\d+) channels=(\d+)/);
      if (fmt) return finish({ ok: true, proc, rate: parseInt(fmt[1], 10), channels: parseInt(fmt[2], 10) });
      const err = buf.match(/ERROR (.+)/);
      if (err) return finish({ ok: false, error: err[1].trim() });
    });
    proc.on("exit", (code) => finish({ ok: false, error: `audio tap exited early (${code})` }));
    proc.on("error", (e) => finish({ ok: false, error: String(e.message ?? e) }));
  });
}
