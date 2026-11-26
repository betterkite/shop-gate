/** Shared coordinate domain for BI charts, including an all-zero series. */
export function chartAxis(min: number, max: number) {
  const upper = max === min ? min + 1 : max;
  return { min, max: upper, spread: upper - min, ticks: [min, min + (upper - min) / 2, upper] };
}
