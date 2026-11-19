// Only a deadline expiring while the governor is awaiting an upstream operation may
// authorize recovery. Provider HTTP statuses, error names, idle clients and EOF do not.
export class UpstreamDeadline {
  readonly signal: AbortSignal;
  private readonly expired = new Error("governor upstream deadline expired");
  constructor(readonly milliseconds: number, clock = (ms: number) => AbortSignal.timeout(ms)) {
    this.signal = clock(milliseconds);
  }
  caused(error: unknown) { return error === this.expired; }
  async wait<T>(start: () => Promise<T>): Promise<T> {
    // A deadline which elapsed elsewhere (e.g. downstream backpressure) is ambiguous.
    if (this.signal.aborted) throw new Error("deadline passed before upstream read");
    let expire!: () => void;
    const timeout = new Promise<never>((_, reject) => { expire = () => reject(this.expired); });
    this.signal.addEventListener("abort", expire, { once: true });
    try { return await Promise.race([timeout, start()]); }
    finally { this.signal.removeEventListener("abort", expire); }
  }
}
