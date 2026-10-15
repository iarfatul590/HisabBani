import { EntryMethod, PendingStatus, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "../config/prisma";
import { LedgerExtraction } from "./ledger-parser";

const customerTypes: TransactionType[] = [TransactionType.CREDIT_DUE, TransactionType.CUSTOMER_PAYMENT];

function parseDueDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00+06:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function createLedgerEntry(
  tx: Prisma.TransactionClient,
  input: { shopId: string; wamid: string; transcript: string; extraction: LedgerExtraction; entryMethod: EntryMethod }
): Promise<void> {
  if (input.extraction.transaction_type === TransactionType.UNKNOWN || input.extraction.amount === null) {
    throw new Error("Cannot post an unclassified or amount-less transaction");
  }
  let customerId: string | null = null;
  const name = input.extraction.customer_name?.trim();
  if (customerTypes.includes(input.extraction.transaction_type) && name) {
    const customer = await tx.customer.findFirst({ where: { shopId: input.shopId, name } });
    customerId = customer?.id ?? (await tx.customer.create({ data: { shopId: input.shopId, name } })).id;
  }
  await tx.ledgerTransaction.create({
    data: {
      shopId: input.shopId,
      sourceWamid: input.wamid,
      transactionType: input.extraction.transaction_type,
      amount: new Prisma.Decimal(input.extraction.amount),
      customerId,
      itemDescription: input.extraction.item_description,
      dueDate: parseDueDate(input.extraction.due_date),
      originalText: input.transcript,
      entryMethod: input.entryMethod
    }
  });
  await tx.inboundMessage.update({
    where: { wamid: input.wamid },
    data: { status: "PROCESSED", transcript: input.transcript, processedAt: new Date() }
  });
}

export async function postExtraction(input: {
  shopId: string; wamid: string; transcript: string; extraction: LedgerExtraction; entryMethod: EntryMethod;
}): Promise<void> {
  await prisma.$transaction((tx) => createLedgerEntry(tx, input));
}

export async function confirmPending(pendingId: string, shopId: string, senderPhone: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const pending = await tx.pendingTransaction.findFirst({
      where: { id: pendingId, shopId, senderPhone },
      include: { inboundMessage: true }
    });
    if (pending?.status === PendingStatus.CONFIRMED) return true;
    if (!pending || !pending.inboundMessage.transcript || pending.amount === null
      || pending.status !== PendingStatus.PENDING || pending.expiresAt <= new Date()
      || pending.transactionType === TransactionType.UNKNOWN) return false;
    await createLedgerEntry(tx, {
      shopId,
      wamid: pending.inboundWamid,
      transcript: pending.inboundMessage.transcript,
      extraction: {
        transaction_type: pending.transactionType,
        amount: Number(pending.amount),
        customer_name: pending.customerName,
        item_description: pending.itemDescription,
        due_date: pending.dueDate?.toISOString().slice(0, 10) ?? null,
        confidence: pending.confidence,
        needs_confirmation: false,
        confirmation_reason: null
      },
      entryMethod: EntryMethod.OWNER_CONFIRMED
    });
    await tx.pendingTransaction.update({ where: { id: pending.id }, data: { status: PendingStatus.CONFIRMED } });
    return true;
  });
}

export async function rejectPending(pendingId: string, shopId: string, senderPhone: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const pending = await tx.pendingTransaction.findFirst({
      where: { id: pendingId, shopId, senderPhone }
    });
    if (!pending) return false;
    if (pending.status === PendingStatus.REJECTED) return true;
    if (pending.status !== PendingStatus.PENDING) return false;
    await tx.pendingTransaction.update({ where: { id: pending.id }, data: { status: PendingStatus.REJECTED } });
    await tx.inboundMessage.update({ where: { wamid: pending.inboundWamid }, data: { status: "IGNORED" } });
    return true;
  });
}

export async function createPending(input: {
  shopId: string; wamid: string; senderPhone: string; extraction: LedgerExtraction; transcript: string;
}): Promise<string> {
  const pending = await prisma.$transaction(async (tx) => {
    await tx.inboundMessage.update({ where: { wamid: input.wamid }, data: { status: "NEEDS_CONFIRMATION", transcript: input.transcript } });
    return tx.pendingTransaction.create({
      data: {
        shopId: input.shopId,
        inboundWamid: input.wamid,
        senderPhone: input.senderPhone,
        transactionType: input.extraction.transaction_type,
        amount: input.extraction.amount === null ? null : new Prisma.Decimal(input.extraction.amount),
        customerName: input.extraction.customer_name,
        itemDescription: input.extraction.item_description,
        dueDate: parseDueDate(input.extraction.due_date),
        confidence: input.extraction.confidence,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
  });
  return pending.id;
}