import { EntryMethod, InboundStatus, TransactionType } from "@prisma/client";
import { Job } from "bullmq";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { convertToMp3 } from "../utils/audio";
import { formatBdt } from "../utils/bangla";
import { getMedia, sendConfirmationButtons, sendText, sendWhatsAppAudio, uploadWhatsAppAudio } from "../utils/meta-whatsapp";
import { confirmPending, createPending, postExtraction, rejectPending } from "./ledger-service";
import { extractLedgerEntry } from "./ledger-parser";
import { synthesizeBanglaReply, transcribeBanglaAudio } from "./speech-to-text";

type Message = {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
  interactive?: { button_reply?: { id?: string } };
};
type MessageJob = { phoneNumberId: string; message: Message };

async function sendOwnerReply(to: string, text: string): Promise<void> {
  await sendText(to, text);
  if (!env.ENABLE_VOICE_REPLIES) return;
  try {
    const audio = await synthesizeBanglaReply(text);
    const mediaId = await uploadWhatsAppAudio(audio);
    await sendWhatsAppAudio(to, mediaId);
  } catch (error) {
    console.error("Voice reply failed; text reply was delivered", error);
  }
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").replace(/^0+/, "");
}

async function handleDecision(shopId: string, senderPhone: string, buttonId: string): Promise<"confirmed" | "rejected" | "invalid"> {
  const separator = buttonId.indexOf(":");
  if (separator < 0) return "invalid";
  const action = buttonId.slice(0, separator);
  const pendingId = buttonId.slice(separator + 1);
  if (action === "confirm") return await confirmPending(pendingId, shopId, senderPhone) ? "confirmed" : "invalid";
  if (action === "reject") return await rejectPending(pendingId, shopId, senderPhone) ? "rejected" : "invalid";
  return "invalid";
}

export async function processInboundMessage(job: Job<MessageJob>): Promise<void> {
  const { phoneNumberId, message } = job.data;
  const shops = await prisma.shop.findMany({ where: { whatsappPhoneNumberId: phoneNumberId }, include: { owner: true } });
  const shop = shops.find((candidate) => normalizePhone(candidate.owner.phoneNumber) === normalizePhone(message.from));
  if (!shop) {
    console.warn(`Ignoring unregistered sender for inbound message ${message.id}`);
    return;
  }
  const record = await prisma.inboundMessage.upsert({
    where: { wamid: message.id },
    create: { wamid: message.id, shopId: shop.id, senderPhone: message.from, messageType: message.type },
    update: {}
  });
  if (record.status === InboundStatus.PROCESSED) {
    const posted = await prisma.ledgerTransaction.findUnique({ where: { sourceWamid: message.id } });
    if (posted) await sendOwnerReply(message.from, `খাতায় যোগ হয়েছে: ${formatBdt(Number(posted.amount))} (${posted.transactionType})`);
    return;
  }
  if (record.status === InboundStatus.IGNORED) return;
  const existingPending = await prisma.pendingTransaction.findUnique({ where: { inboundWamid: message.id } });
  if (existingPending?.status === "PENDING" && existingPending.expiresAt > new Date()) {
    await prisma.inboundMessage.update({ where: { wamid: message.id }, data: { status: InboundStatus.NEEDS_CONFIRMATION } });
    const details = [
      existingPending.transactionType,
      existingPending.amount === null ? "টাকার পরিমাণ নেই" : formatBdt(Number(existingPending.amount)),
      existingPending.customerName,
      existingPending.itemDescription
    ].filter(Boolean).join(" | ");
    await sendConfirmationButtons(message.from, `খাতায় যোগ করার আগে নিশ্চিত করুন: ${details}`, existingPending.id);
    return;
  }
  if (record.status === InboundStatus.NEEDS_CONFIRMATION) return;
  await prisma.inboundMessage.update({ where: { wamid: message.id }, data: { status: InboundStatus.PROCESSING } });

  try {
    const buttonId = message.interactive?.button_reply?.id;
    if (buttonId) {
      const decision = await handleDecision(shop.id, message.from, buttonId);
      await prisma.inboundMessage.update({
        where: { wamid: message.id },
        data: { status: decision === "invalid" ? InboundStatus.IGNORED : InboundStatus.PROCESSED, processedAt: new Date() }
      });
      const reply = decision === "confirmed"
        ? "আপনার উত্তর অনুযায়ী খাতা আপডেট করা হয়েছে।"
        : decision === "rejected" ? "ঠিক আছে, এই লেনদেনটি খাতায় যোগ করা হয়নি।" : "এই নিশ্চিতকরণটি মেয়াদোত্তীর্ণ বা পাওয়া যায়নি।";
      await sendOwnerReply(message.from, reply);
      return;
    }

    let transcript: string;
    if (message.type === "audio" && message.audio?.id) {
      const audio = await getMedia(message.audio.id);
      transcript = await transcribeBanglaAudio(await convertToMp3(audio.bytes, audio.mimeType));
    } else if (message.type === "text" && message.text?.body) transcript = message.text.body.trim();
    else {
      await prisma.inboundMessage.update({ where: { wamid: message.id }, data: { status: InboundStatus.IGNORED } });
      await sendOwnerReply(message.from, "ভয়েস নোট বা টেক্সট হিসেবে লেনদেনটি পাঠান।");
      return;
    }

    const extraction = await extractLedgerEntry(transcript);
    const requiresCustomer = [TransactionType.CREDIT_DUE, TransactionType.CUSTOMER_PAYMENT].includes(extraction.transaction_type);
    if (extraction.amount === null || extraction.transaction_type === TransactionType.UNKNOWN
      || (requiresCustomer && !extraction.customer_name)) {
      await prisma.inboundMessage.update({ where: { wamid: message.id }, data: { status: InboundStatus.IGNORED, transcript } });
      await sendOwnerReply(message.from, "লেনদেনটি বুঝতে পারিনি। টাকার পরিমাণ এবং ক্রেতা/পাওনাদারের নামসহ আবার পাঠান।");
      return;
    }
    if (extraction.needs_confirmation || extraction.confidence < env.AUTO_POST_CONFIDENCE) {
      const pendingId = await createPending({ shopId: shop.id, wamid: message.id, senderPhone: message.from, extraction, transcript });
      const details = [extraction.transaction_type, formatBdt(extraction.amount), extraction.customer_name, extraction.item_description]
        .filter(Boolean).join(" | ");
      await sendConfirmationButtons(message.from, `খাতায় যোগ করার আগে নিশ্চিত করুন: ${details}`, pendingId);
      return;
    }
    await postExtraction({ shopId: shop.id, wamid: message.id, transcript, extraction, entryMethod: EntryMethod.AI_AUTO });
    await sendOwnerReply(message.from, `খাতায় যোগ হয়েছে: ${formatBdt(extraction.amount)} (${extraction.transaction_type})`);
  } catch (error) {
    const posted = await prisma.ledgerTransaction.findUnique({ where: { sourceWamid: message.id }, select: { id: true } });
    await prisma.inboundMessage.update({
      where: { wamid: message.id },
      data: {
        status: posted ? InboundStatus.PROCESSED : InboundStatus.FAILED,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown processing error"
      }
    });
    throw error;
  }
}