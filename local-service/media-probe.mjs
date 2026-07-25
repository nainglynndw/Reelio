import { spawn } from "node:child_process";
import ffprobe from "ffprobe-static";

export async function probeMedia(file, timeoutMs = 20_000) {
  const output = await runProbe([
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    file,
  ], timeoutMs);
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error("The uploaded media could not be inspected."); }
  const duration = Number(parsed.format?.duration);
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    video: videoStream ? { width: Number(videoStream.width) || 0, height: Number(videoStream.height) || 0 } : null,
    audio: Boolean(audioStream),
  };
}

function runProbe(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe.path, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error("Media inspection timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", finishReject);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || "The uploaded media is not readable."));
    });
    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
