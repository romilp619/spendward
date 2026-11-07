import { z } from "zod";
import { chat } from "./llm.js";
import { directory } from "./merchants.js";

/**
 * Turns "let my agent buy office supplies, up to $300 a month, only from Best
 * Buy" into the fields of a mandate.
 *
 * The model drafts; it never decides. Its output is validated, clamped to sane
 * values, shown to the principal as an editable form with every assumption
 * spelled out, and only becomes a mandate when the principal signs it. The
 * rules that later enforce the mandate contain no model at all.
 */
export const DraftSchema = z.object({
  maxTransactionAmount: z.number().positive().max(100_000),
  approvalCeiling: z.number().positive().max(100_000),
  maxTotalAmount: z.number().positive().max(1_000_000),
  budgetPeriod: z.enum(["none", "day", "week", "month"]),
  maxQuantity: z.number().int().min(1).max(100),
  allowedMerchants: z.array(z.string().min(1).max(80)).min(1).max(20),
  allowedCategories: z.array(z.string().min(1).max(60)).max(20),
  allowSubscriptions: z.boolean(),
  expiresInDays: z.number().int().min(1).max(365),
});
export type Draft = z.infer<typeof DraftSchema>;

export interface DraftResult {
  draft: Draft;
  /** Each choice the model made that the principal did not state outright. */
  assumptions: string[];
  /** Requested merchants with no PayPal account on record; they cannot be signed in. */
  unknownMerchants: string[];
}

export async function draftMandate(text: string): Promise<DraftResult> {
  const known = Object.entries(directory()).map(([k, v]) => `${k} (${v.name})`).join(", ") || "none";
  const reply = await chat(
    [
      {
        role: "system",
        content:
          "You convert a person's description of what their AI shopping agent may buy into a spending mandate. " +
          "Reply with one JSON object only, with keys: maxTransactionAmount, approvalCeiling, maxTotalAmount, " +
          "budgetPeriod (none|day|week|month), maxQuantity, allowedMerchants (array), allowedCategories (array, empty = any), " +
          "allowSubscriptions (boolean), expiresInDays, assumptions (array of short plain-English sentences).\n" +
          "Rules: amounts are USD numbers. approvalCeiling must be >= maxTransactionAmount; if the person does not say, " +
          "set it to maxTransactionAmount * 1.2 rounded to a whole number. maxTotalAmount is the budget per budgetPeriod. " +
          "Default to the strictest reasonable reading: subscriptions false, maxQuantity 1, expiresInDays 30, unless stated. " +
          `Merchants must be written as the merchant ids the system knows when one matches: ${known}. ` +
          "Categories are matched as whole words inside a shop's own category name, so prefer short general words: " +
          "\"headphones\" matches \"In-Ear Headphones\" and \"Over-Ear Headphones\"; leave the list empty if the person did not limit what kind of thing. " +
          "Every value you choose that the person did not state explicitly must be listed in assumptions. " +
          "Do not invent permissions the person did not ask for.",
      },
      { role: "user", content: text.slice(0, 2000) },
    ],
    { json: true },
  );

  const raw = JSON.parse((reply.content ?? "{}").replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown>;
  const draft = DraftSchema.parse(raw);
  const assumptions = Array.isArray(raw.assumptions) ? raw.assumptions.map(String).slice(0, 12) : [];

  // Clamp rather than trust: the ceiling can never sit below the limit it extends.
  if (draft.approvalCeiling < draft.maxTransactionAmount) {
    draft.approvalCeiling = draft.maxTransactionAmount;
    assumptions.push("Raised the approval ceiling to the per-payment limit; it cannot be lower.");
  }
  const dir = directory();
  return { draft, assumptions, unknownMerchants: draft.allowedMerchants.filter((m) => !dir[m]) };
}
