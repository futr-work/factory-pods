import type { HandlerContext, TaskHandler, TaskRecord } from "./types.js";
import { MeasurementService } from "./service.js";
import { sha256Hex } from "@futr-work/pod-kernel/auth";

/**
 * Autonomous Measurement Pod TaskHandler.
 * Handles Tincan mesh & API tasks (`measurement.register`, `measurement.define`,
 * `measurement.ingest`, `measurement.query`, `measurement.coverage`, `measurement.annotate`)
 * strictly through the composed PodStorage seam and emits cryptographic receipts.
 */
export class MeasurementPodHandler implements TaskHandler {
  public name = "measurement-pod-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return topic.startsWith("measurement.") || topic === "task.assigned";
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, storage, publishEvent } = context;
    const service = new MeasurementService(storage);
    const spec = task.spec || {};
    const action = spec.action || (task.topic.includes(".") ? task.topic.split(".")[1] : "coverage");

    let domainOutput: any;

    switch (action) {
      case "register":
      case "register_resource":
        domainOutput = await service.registerResource(spec.payload ?? spec, now);
        break;
      case "define":
      case "define_metric":
        domainOutput = await service.defineMetric(spec.payload ?? spec, now);
        break;
      case "ingest":
      case "record":
        domainOutput = await service.ingestBatch(spec.payload ?? spec, now);
        break;
      case "query":
      case "compare":
        domainOutput = await service.querySeries(spec.payload ?? spec);
        break;
      case "annotate":
        domainOutput = await service.annotateWork(spec.payload ?? spec, now);
        break;
      case "coverage":
      case "reconcile":
      default:
        domainOutput = spec.tenantId
          ? await service.queryCoverage({
              tenantId: spec.tenantId,
              resourceId: spec.resourceId,
              source: spec.source,
            })
          : await service.getCockpitSnapshot();
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
      // Mesh offline; task result still persisted locally
    }

    return result;
  }
}

export const activeHandler: TaskHandler = new MeasurementPodHandler();
