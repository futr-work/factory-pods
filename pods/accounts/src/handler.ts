import type { HandlerContext, TaskHandler, TaskRecord } from "./types.js";
import { AccountsService } from "./service.js";
import { sha256Hex } from "@futr-work/pod-kernel/auth";

export class AccountsPodHandler implements TaskHandler {
  public name = "accounts-pod-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return topic.startsWith("accounts.") || topic === "task.assigned";
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, storage, publishEvent } = context;
    const service = new AccountsService(storage);
    const spec = task.spec && typeof task.spec === "object" ? task.spec : {};
    const payload = spec.payload && typeof spec.payload === "object" ? spec.payload : spec;
    const action = spec.action || (task.topic.includes(".") ? task.topic.split(".")[1] : "matrix");

    if (!payload.tenantId || typeof payload.tenantId !== "string" || !payload.tenantId.trim()) {
      throw new Error("Scoped accounts task requires an explicit tenantId");
    }

    let domainOutput: any;
    switch (action) {
      case "who_owns":
        domainOutput = await service.whoOwns(payload.tenantId, payload.assetId, payload.expectedProviders || []);
        break;
      case "overlaps":
      case "gaps":
        domainOutput = await service.queryOverlapsAndGaps(payload.tenantId, payload.expectedProviders || ["gsc", "bing_webmaster"], payload.assetKind);
        break;
      case "discover":
      case "ingest_discovery":
        domainOutput = await service.ingestDiscovery(payload as any, task.ownerId || "hub", now);
        break;
      case "matrix":
      default:
        domainOutput = await service.queryMatrix({
          tenantId: payload.tenantId,
          assetKind: payload.assetKind,
          provider: payload.provider,
          brandGroup: payload.brandGroup,
        });
        break;
    }

    const receiptHash = await sha256Hex(`${task.taskId}:${podConfig.id}:${JSON.stringify(domainOutput)}`);
    const result = {
      status: "completed",
      completedBy: podConfig.id,
      role: podConfig.role,
      taskId: task.taskId,
      topic: task.topic,
      action,
      receiptHash,
      result: domainOutput,
      completedAt: new Date(now).toISOString(),
    };

    try {
      await publishEvent("task.completed", "hub", {
        taskId: task.taskId,
        workerPod: podConfig.id,
        event: "completed",
        receiptHash,
        action,
        timestamp: now,
      });
    } catch {
      // Mesh offline
    }
    return result;
  }
}

export const activeHandler: TaskHandler = new AccountsPodHandler();
