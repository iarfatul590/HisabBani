import { Prisma, TransactionType } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { formatBdt } from "../utils/bangla";
import { sendDueReminder } from "../utils/meta-whatsapp";

function getLocalDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function sendDueReminders(): Promise<void> {
  if (!env.WHATSAPP_DUE_REMINDER_TEMPLATE) {
    console.warn("Due reminders skipped: WhatsApp template is not configured");
    return;
  }
  const now = new Date();
  const candidates = await prisma.customer.findMany({
    where: {
      remindersOptIn: true,
      phoneNumber: { not: null },
      transactions: { some: { transactionType: TransactionType.CREDIT_DUE, dueDate: { lte: now } } }
    },
    include: { shop: true, transactions: { select: { transactionType: true, amount: true, dueDate: true } } }
  });
  const localDate = getLocalDate(env.REMINDER_TIMEZONE);
  for (const customer of candidates) {
    const overdueCredit = customer.transactions.reduce((total, transaction) => {
      const amount = Number(transaction.amount);
      if (transaction.transactionType === TransactionType.CREDIT_DUE && transaction.dueDate && transaction.dueDate <= now) {
        return total + amount;
      }
      if (transaction.transactionType === TransactionType.CUSTOMER_PAYMENT) return total - amount;
      return total;
    }, 0);
    const balance = Math.max(overdueCredit, 0);
    if (balance <= 0 || !customer.phoneNumber) continue;
    const alreadySent = await prisma.reminderLog.findUnique({
      where: { customerId_localDate: { customerId: customer.id, localDate } },
      select: { id: true }
    });
    if (alreadySent) continue;
    await sendDueReminder(customer.phoneNumber, customer.name, customer.shop.name, formatBdt(balance));
    try {
      await prisma.reminderLog.create({ data: { shopId: customer.shopId, customerId: customer.id, localDate } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
}