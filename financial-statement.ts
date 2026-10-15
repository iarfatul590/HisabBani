import { TransactionType } from "@prisma/client";
import { prisma } from "../config/prisma";
import { calculateShopScore } from "./credit-scoring";

export async function buildFinancialStatement(input: { shopId: string; from: Date; to: Date }) {
  if (input.from >= input.to) throw new Error("Statement start must be before its end");
  const [shop, allTransactions, score] = await Promise.all([
    prisma.shop.findUnique({ where: { id: input.shopId }, include: { owner: true } }),
    prisma.ledgerTransaction.findMany({
      where: { shopId: input.shopId, occurredAt: { lt: input.to } },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { occurredAt: "asc" }
    }),
    calculateShopScore(input.shopId)
  ]);
  if (!shop) throw new Error("Shop not found");
  const transactions = allTransactions.filter((transaction) => transaction.occurredAt >= input.from);

  const totals = {
    cashSales: 0,
    creditSales: 0,
    customerCollections: 0,
    expenses: 0,
    supplierDebt: 0,
    supplierPayments: 0
  };
  const customerBalances = new Map<string, { customerId: string; name: string; balanceBdt: number }>();
  for (const transaction of allTransactions) {
    const amount = Number(transaction.amount);
    const inPeriod = transaction.occurredAt >= input.from;
    switch (transaction.transactionType) {
      case TransactionType.CASH_SALE:
        if (inPeriod) totals.cashSales += amount;
        break;
      case TransactionType.CREDIT_DUE:
        if (inPeriod) totals.creditSales += amount;
        if (transaction.customer) {
          const current = customerBalances.get(transaction.customer.id) ?? {
            customerId: transaction.customer.id, name: transaction.customer.name, balanceBdt: 0
          };
          current.balanceBdt += amount;
          customerBalances.set(transaction.customer.id, current);
        }
        break;
      case TransactionType.CUSTOMER_PAYMENT:
        if (inPeriod) totals.customerCollections += amount;
        if (transaction.customer) {
          const current = customerBalances.get(transaction.customer.id) ?? {
            customerId: transaction.customer.id, name: transaction.customer.name, balanceBdt: 0
          };
          current.balanceBdt -= amount;
          customerBalances.set(transaction.customer.id, current);
        }
        break;
      case TransactionType.EXPENSE: if (inPeriod) totals.expenses += amount; break;
      case TransactionType.DEBT: if (inPeriod) totals.supplierDebt += amount; break;
      case TransactionType.SUPPLIER_PAYMENT: if (inPeriod) totals.supplierPayments += amount; break;
      default: break;
    }
  }
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    shop: { id: shop.id, name: shop.name, ownerName: shop.owner.name },
    period: { from: input.from.toISOString(), to: input.to.toISOString(), currency: "BDT" },
    transactionCount: transactions.length,
    totalsBdt: {
      ...totals,
      estimatedNetCashflow: totals.cashSales + totals.customerCollections - totals.expenses - totals.supplierPayments
    },
    customerBalances: [...customerBalances.values()].filter((item) => item.balanceBdt > 0),
    internalReadiness: score
  };
}