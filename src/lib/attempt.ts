/**
 * try / catch / finally as a call. The React compiler cannot yet compile a
 * component holding a `finally` clause, a `try` without `catch`, or a `throw`
 * inside `try`; the workspace's handlers use this instead, so the component
 * is compiled. It resolves to what body returns, or, when body throws and
 * onError is given, to what onError returns; without onError the error
 * propagates. onFinally runs either way.
 */
export async function attempt<T, E = undefined>(
  body: () => T | Promise<T>,
  onError?: (cause: unknown) => E | Promise<E>,
  onFinally?: () => unknown,
): Promise<T | E> {
  try {
    return await body();
  } catch (cause) {
    if (!onError) throw cause;
    return await onError(cause);
  } finally {
    await onFinally?.();
  }
}
