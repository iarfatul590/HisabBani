import { TransactionType } from "@prisma/client";
import { z } from "zod";
import { env } from "../config/env";
import { openai } from "../config/openai";

const extractionSchema = z.object({
  transaction_type: z.nativeEnum(TransactionType),
  customer_name: z.string().nullable(),
  amount: z.number().positive().nullable(),
  item_description: z.string().nullable(),
  due_date: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  needs_confirmation: z.boolean(),
  confirmation_reason: z.string().nullable()
});
export type LedgerExtraction = z.infer<typeof extractionSchema>;

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["transaction_type", "customer_name", "amount", "item_description", "due_date", "confidence", "needs_confirmation", "confirmation_reason"],
  properties: {
    transaction_type: { type: "string", enum: Object.values(TransactionType) },
    customer_name: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    item_description: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    confidence: { type: "number" },
    needs_confirmation: { type: "boolean" },
    confirmation_reason: { type: ["string", "null"] }
  }
};

export async function extractLedgerEntry(transcript: string): Promise<LedgerExtraction> {
  const result = await openai.chat.completions.create({
    model: env.OPENAI_EXTRACTION_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: { name: "ledger_extraction", strict: true, schema: responseSchema } },
    messages: [
      {
        role: "system",
        content: [
          "Extract one shop ledger event from Bangla, regional Bangla, or Banglish text.",
          "Never invent an amount, person, item, or date. Preserve names as spoken.",
          "Normalize Bengali numerals and spoken amounts to a number in BDT taka.",
          "CREDIT_DUE means a customer took goods now and will pay later.",
          "DEBT is supplier/business debt; CUSTOMER_PAYMENT collects an old customer balance.",
          "CASH_SALE is cash received for a sale; EXPENSE is a shop expense; SUPPLIER_PAYMENT settles supplier debt.",
          "Use UNKNOWN if the event cannot safely be classified.",
          "Ambiguous amount/type/person, contradictory text, or correction request requires confirmation.",
          "Do not infer a due date or use today's date unless explicitly stated.",
          "Confidence is for the full extracted event, not only transcription quality."
        ].join(" ")
      },
      { role: "user", content: transcript }
    ]
  });
  const content = result.choices[0]?.message.content;
  if (!content) throw new Error("The extraction model returned an empty response");
  return extractionSchema.parse(JSON.parse(content));
}