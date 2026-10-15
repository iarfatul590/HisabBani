import { env } from "../config/env";

type WhatsAppResponse = { messages?: Array<{ id: string }> };
const apiRoot = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}`;

async function graphRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`WhatsApp API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json() as Promise<T>;
}

export async function getMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const metadata = await graphRequest<{ url: string; mime_type?: string }>(`${apiRoot}/${mediaId}`);
  const response = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > env.MAX_AUDIO_BYTES) throw new Error("Audio exceeds configured size limit");
  return { bytes, mimeType: metadata.mime_type ?? "audio/ogg" };
}

export async function sendText(to: string, body: string): Promise<void> {
  await graphRequest(`${apiRoot}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } })
  });
}

export async function sendConfirmationButtons(to: string, body: string, pendingId: string): Promise<void> {
  await graphRequest(`${apiRoot}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
      interactive: {
        type: "button", body: { text: body },
        action: { buttons: [
          { type: "reply", reply: { id: `confirm:${pendingId}`, title: "ঠিক আছে" } },
          { type: "reply", reply: { id: `reject:${pendingId}`, title: "ভুল হয়েছে" } }
        ] }
      }
    })
  });
}

export async function sendDueReminder(to: string, customerName: string, shopName: string, amount: string): Promise<void> {
  const templateName = env.WHATSAPP_DUE_REMINDER_TEMPLATE;
  if (!templateName) throw new Error("Due reminder template is not configured");
  await graphRequest(`${apiRoot}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
      template: {
        name: templateName, language: { code: "bn" },
        components: [{ type: "body", parameters: [
          { type: "text", text: customerName },
          { type: "text", text: shopName },
          { type: "text", text: amount }
        ] }]
      }
    })
  });
}

export async function uploadWhatsAppAudio(bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "audio/mpeg");
  form.set("file", new Blob([Uint8Array.from(bytes)], { type: "audio/mpeg" }), "reply.mp3");
  const response = await fetch(`${apiRoot}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`WhatsApp media upload failed with ${response.status}`);
  const result = await response.json() as { id?: string };
  if (!result.id) throw new Error("WhatsApp media upload returned no media ID");
  return result.id;
}

export async function sendWhatsAppAudio(to: string, mediaId: string): Promise<void> {
  await graphRequest(`${apiRoot}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "audio",
      audio: { id: mediaId }
    })
  });
}