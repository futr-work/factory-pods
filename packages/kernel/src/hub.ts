// @futr-work/pod-kernel: Hub registration & heartbeat module
// Connects pod to factory-hub mesh with heartbeat and telemetry

export interface HubRegistrationOptions {
  hubUrl: string;
  token: string;
  podName: string;
  port: number;
  role: string;
  heartbeatIntervalMs?: number;
}

export class HubClient {
  private options: HubRegistrationOptions;
  private intervalTimer?: NodeJS.Timeout;

  constructor(options: HubRegistrationOptions) {
    this.options = options;
  }

  async register(): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.options.hubUrl}/api/flow/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: this.options.podName,
          role: this.options.role,
          port: this.options.port,
          registeredAt: new Date().toISOString(),
        }),
      });
      return { ok: res.ok, message: await res.text() };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 30_000;
    this.intervalTimer = setInterval(async () => {
      try {
        await fetch(`${this.options.hubUrl}/api/flow/heartbeat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: this.options.podName,
            status: "healthy",
            timestamp: new Date().toISOString(),
          }),
        });
      } catch {}
    }, interval);
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }
}
