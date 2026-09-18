const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function fmtMoney(pence: number | null | undefined): string {
  return pence === null || pence === undefined ? '—' : gbp.format(pence / 100);
}

/** Parses "1,234.50" / "£99" into integer pence. */
export function parsePence(input: string): number {
  const clean = input.replace(/[£,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) throw new Error(`Invalid amount: ${input}`);
  return Math.round(parseFloat(clean) * 100);
}

export function penceToInput(pence: number | null | undefined): string {
  return pence === null || pence === undefined ? '' : (pence / 100).toFixed(2);
}
