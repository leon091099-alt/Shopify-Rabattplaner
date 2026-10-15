export function targetCompareCents(originalPrice, originalCompare, mode) {
  if (mode === "keep_higher" && originalCompare != null && originalCompare > originalPrice) {
    return originalCompare;
  }
  return originalPrice;
}

export function pricesEqual(priceA, compareA, priceB, compareB) {
  return priceA === priceB && (compareA ?? null) === (compareB ?? null);
}

export function hasExistingDiscount(priceCents, compareCents) {
  return compareCents != null && priceCents != null && compareCents > priceCents;
}
