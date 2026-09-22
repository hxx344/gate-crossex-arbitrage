/** One active read; superseded, hidden, cancelled and timed-out responses cannot update the UI. */
export function createLatestRead<T>({ canRead, load, onData, onError, timeoutMs = 12_000 }: {
  canRead: () => boolean; load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void; onError: (error: unknown) => void; timeoutMs?: number;
}) {
  let sequence = 0, controller: AbortController | null = null, pending: Promise<void> | null = null;
  const cancel = () => { sequence++; controller?.abort(); controller = null; pending = null; };
  return { cancel, refresh(force = false): Promise<void> {
    if (!canRead()) return Promise.resolve();
    if (force) cancel();
    if (pending) return pending;
    const version = ++sequence, own = new AbortController(); controller = own;
    const timeout = AbortSignal.timeout(timeoutMs), signal = AbortSignal.any([own.signal, timeout]);
    pending = Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return load(signal); })
      .then(value => { if (version === sequence && !signal.aborted && canRead()) onData(value); })
      .catch(error => { if (version === sequence && !own.signal.aborted && canRead()) onError(error); })
      .finally(() => { if (version === sequence) { pending = null; controller = null; } });
    return pending;
  } };
}
