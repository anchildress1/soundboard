/** A copy of `value` without `keys`, for tests about fields a request or reply left out. */
export function omit<T extends object>(value: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  ) as Partial<T>;
}
