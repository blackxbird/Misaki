/**
 * Drop a response body without waiting. Awaiting cancel() on a body that has
 * been clone()d never settles until the other tee branch is cancelled too, so
 * callers that only want to discard the bytes must not block on it.
 */
export function discardBody(response: Response | null | undefined): void {
  void response?.body?.cancel().catch(() => undefined);
}
