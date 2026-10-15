import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export async function convertToMp3(bytes: Buffer, mimeType: string): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg binary is unavailable on this platform");
  const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "ogg";
  const directory = await mkdtemp(path.join(tmpdir(), "hisabbani-audio-"));
  const inputPath = path.join(directory, `input.${extension}`);
  const outputPath = path.join(directory, "output.mp3");
  try {
    await writeFile(inputPath, bytes, { mode: 0o600 });
    await execFileAsync(ffmpegPath, ["-nostdin", "-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", outputPath], {
      timeout: 60_000, maxBuffer: 1_000_000
    });
    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}