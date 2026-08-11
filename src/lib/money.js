/** Cents -> "$12.50". Money is stored as integers; only display converts. */
export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
