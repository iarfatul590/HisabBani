import { toFile } from "openai";
import { env } from "../config/env";
import { openai } from "../config/openai";

export async function transcribeBanglaAudio(mp3: Buffer): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    file: await toFile(mp3, "voice-note.mp3", { type: "audio/mpeg" }),
    model: env.OPENAI_STT_MODEL,
    language: "bn",
    response_format: "text",
    prompt: "Bangladeshi Bangla speech, including regional dialects and Banglish shop terms."
  });
  const text = typeof transcription === "string" ? transcription : transcription.text;
  if (!text.trim()) throw new Error("No speech was recognized in the audio");
  return text.trim();
}

export async function synthesizeBanglaReply(text: string): Promise<Buffer> {
  const speech = await openai.audio.speech.create({
    model: env.OPENAI_TTS_MODEL,
    voice: env.OPENAI_TTS_VOICE as "coral",
    input: text,
    response_format: "mp3",
    instructions: "Speak clearly and warmly in Bangladeshi Bangla. Read amounts naturally."
  });
  return Buffer.from(await speech.arrayBuffer());
}