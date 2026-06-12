export function validateParams<K extends string>(
  params: object,
  allowed: readonly K[],
): void {
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(params)) {
    if (!allowedSet.has(key)) throw new Error(`unknown param key: ${key}`);
  }
}
