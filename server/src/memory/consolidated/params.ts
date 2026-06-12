export function validateParams(params: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(params)) {
    if (!allowedSet.has(key)) throw new Error(`invalid params: unknown key ${JSON.stringify(key)}`);
  }
}
