import { TransactionType } from "@prisma/client";
import { prisma } from "../config/prisma";

type ScoreResult = {
  score: number | null;
  confidence: number;
  status: "READY_FOR_REVIEW" | "INSUFFICIENT_DATA";
  components: Record<string, number>;
  transactionCount: number;
  historyDays: number;
};
const clamp = (value: number): number => Math.max(0, Math.min(100, value));

export async function calculateShopScore(shopId: string): Promise<ScoreResult> {
  const transactions = await prisma.ledgerTransaction.findMany({
    where: { shopId, occurredAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
    orderBy: { occurredAt: "asc" }
  });
  const first = transactions[0]?.occurredAt;
  const historyDays = first ? Math.floor((Date.now() - first.getTime()) / 86_400_000) : 0;
  const activeDays = new Set(transactions.map((row) => row.occurredAt.toISOString().slice(0, 10))).size;
  const confirmed = transactions.filter((row) => row.entryMethod === "OWNER_CONFIRMED").length;
  const dataQuality = clamp((activeDays / 60) * 60 + (confirmed / Math.max(transactions.length, 1)) * 40);
  const ledgerConsistency = clamp((activeDays / 45) * 100);
  const weeklySales = new Array<number>(13).fill(0);
  let inflows = 0;
  let outflows = 0;
  let creditDue = 0;
  let collections = 0;
  for (const row of transactions) {
    const amount = Number(row.amount);
    const weekAgo = Math.min(12, Math.floor((Date.now() - row.occurredAt.getTime()) / (7 * 86_400_000)));
    if (row.transactionType === TransactionType.CASH_SALE) {
      inflows += amount;
      weeklySales[12 - weekAgo] = (weeklySales[12 - weekAgo] ?? 0) + amount;
    } else if (row.transactionType === TransactionType.CREDIT_DUE) {
      creditDue += amount;
      weeklySales[12 - weekAgo] = (weeklySales[12 - weekAgo] ?? 0) + amount;
    }
    else if (row.transactionType === TransactionType.CUSTOMER_PAYMENT) {
      collections += amount;
      inflows += amount;
    } else if ([TransactionType.EXPENSE, TransactionType.DEBT, TransactionType.SUPPLIER_PAYMENT].includes(row.transactionType)) {
      outflows += amount;
    }
  }
  const activeWeeks = weeklySales.filter((amount) => amount > 0);
  const average = activeWeeks.length ? activeWeeks.reduce((sum, value) => sum + value, 0) / activeWeeks.length : 0;
  const variance = activeWeeks.length > 1
    ? activeWeeks.reduce((sum, value) => sum + (value - average) ** 2, 0) / activeWeeks.length
    : 0;
  const salesStability = clamp(100 - (average ? Math.sqrt(variance) / average : 1) * 45);
  const cashflowHealth = clamp(50 + ((inflows - outflows) / Math.max(inflows, 1)) * 50);
  const repaymentBehavior = creditDue > 0 ? clamp((collections / creditDue) * 100) : 50;
  const liquidityBuffer = clamp((Math.max(inflows - outflows, 0) / Math.max(outflows, 1)) * 50);
  const components = { repaymentBehavior, cashflowHealth, salesStability, ledgerConsistency, liquidityBuffer, dataQuality };
  const confidence = Math.round(clamp((historyDays / 90) * 60 + Math.min(transactions.length / 120, 1) * 40));
  if (transactions.length < 30 || historyDays < 60) {
    const result: ScoreResult = { score: null, confidence, status: "INSUFFICIENT_DATA", components, transactionCount: transactions.length, historyDays };
    await prisma.creditScoreSnapshot.create({ data: { shopId, ...result } });
    return result;
  }
  const weighted = repaymentBehavior * 0.25 + cashflowHealth * 0.20 + salesStability * 0.20
    + dataQuality * 0.10 + liquidityBuffer * 0.10 + dataQuality * 0.15;
  const result: ScoreResult = {
    score: Math.round(weighted * 10), confidence, status: "READY_FOR_REVIEW", components, transactionCount: transactions.length, historyDays
  };
  await prisma.creditScoreSnapshot.create({ data: { shopId, ...result } });
  return result;
}