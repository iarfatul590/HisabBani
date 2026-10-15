const bengaliDigits = "০১২৩৪৫৬৭৮৯";

export function toBengaliDigits(value: string | number): string {
  return String(value).replace(/\d/g, (digit) => bengaliDigits[Number(digit)] ?? digit);
}

export function formatBdt(amount: number): string {
  return `৳${toBengaliDigits(new Intl.NumberFormat("en-BD", { maximumFractionDigits: 2 }).format(amount))}`;
}