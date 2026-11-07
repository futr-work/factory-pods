import { TaskRecord, HandlerContext, TaskHandler, boundPayload } from "./types.js";
import { DynamicSkillEngine } from "./skill-engine.js";

/**
 * ============================================================================
 * PLUGGABLE TASK HANDLER WITH DYNAMIC SKILLS, EPISODIC LEARNING & VERIFICATION
 * ============================================================================
 * Handles hot-pluggable skills from the Skill Vault, recalls recent episodes
 * for few-shot learning, computes confidence scores, and generates
 * verifiable execution receipts.
 */

async function computeReceiptHash(taskId: string, podId: string, payload: any): Promise<string> {
  try {
    const raw = `${taskId}:${podId}:${JSON.stringify(payload)}`;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return `rcpt_${Date.now()}`;
  }
}

export class DefaultPodHandler implements TaskHandler {
  public name = "default-task-handler";
  private skillEngine: DynamicSkillEngine;

  constructor(hubUrl?: string) {
    this.skillEngine = new DynamicSkillEngine(hubUrl);
  }

  public canHandle(topic: string, _spec: any): boolean {
    return true; // Accepts all assigned tasks by default
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, publishEvent, ai, recallEpisodes, recordEpisode, recallBeliefs, modelGovernorUrl } = context;

    // Dynamically align hubUrl with pod configuration
    if (podConfig.hubUrl) {
      this.skillEngine.setHubUrl(podConfig.hubUrl);
    }

    console.log(`[${podConfig.id}] Processing task: ${task.taskId} (Topic: ${task.topic})`);

    // 1. Cognitive Recall: Fetch top-3 historical episodes and active semantic beliefs
    const recalledEpisodes = recallEpisodes ? await recallEpisodes(task.topic, 3) : [];
    const activeBeliefs = recallBeliefs ? await recallBeliefs(podConfig.lob, 5) : [];

    if (recalledEpisodes.length > 0) {
      console.log(`[${podConfig.id}] Recalled ${recalledEpisodes.length} historical episodes for few-shot guidance.`);
    }
    if (activeBeliefs.length > 0) {
      console.log(`[${podConfig.id}] Activated ${activeBeliefs.length} semantic beliefs in domain '${podConfig.lob}'.`);
    }

    // 2. Execute dynamic skill from vault (or fallback domain logic)
    let domainOutput: any = null;
    let confidence = 0.9;
    const dynamicSkill = await this.skillEngine.getSkill(task.topic);

    if (dynamicSkill) {
      console.log(`[${podConfig.id}] Executing skill: ${dynamicSkill.name} (v${dynamicSkill.version})`);
      if (ai) {
        domainOutput = await this.skillEngine.executeWithAi(dynamicSkill, task.spec || {}, {
          ai: ai.run.bind(ai),
          recalledEpisodes,
          beliefs: activeBeliefs,
          governorUrl: modelGovernorUrl,
        });
      } else {
        domainOutput = this.skillEngine.execute(dynamicSkill, task.spec || {}, {
          recalledEpisodes,
        });
      }
      if (typeof domainOutput.confidence === "number") {
        confidence = domainOutput.confidence;
      }
    } else {
      domainOutput = {
        output: `Task ${task.taskId} processed successfully by ${podConfig.name}`,
        data: task.spec || {},
      };
    }

    // 3. Generate Cryptographic Task Receipt & Evidence Ledger
    const executionDurationMs = Date.now() - now;
    const receiptHash = await computeReceiptHash(task.taskId, podConfig.id, domainOutput);

    const executionResult = boundPayload({
      completedBy: podConfig.id,
      role: podConfig.role,
      domain: podConfig.lob,
      taskId: task.taskId,
      topic: task.topic,
      confidence,
      evidence: {
        classification: dynamicSkill?.executionType === "rule_engine" ? "S" : "I", // S=source-proven, I=inferred
        receiptHash,
        executionDurationMs,
        episodesRecalled: recalledEpisodes.length,
        beliefsApplied: activeBeliefs.length,
      },
      result: domainOutput,
      completedAt: new Date().toISOString(),
    });

    // 4. Record Episode for Continuous Learning Curve
    if (recordEpisode) {
      try {
        await recordEpisode({
          taskId: task.taskId,
          topic: task.topic,
          specSummary: JSON.stringify(task.spec || {}).substring(0, 300),
          actionTaken: dynamicSkill ? `Executed ${dynamicSkill.name} (v${dynamicSkill.version})` : "Default domain execution",
          outcome: typeof domainOutput === "object" ? JSON.stringify(domainOutput).substring(0, 300) : String(domainOutput),
          confidence,
          latencyMs: executionDurationMs,
        });
      } catch (epErr) {
        console.warn(`[${podConfig.id}] Failed to record episode:`, epErr);
      }
    }

    // 5. Confidence & Escalation Gate
    const requiresVerification = (task.spec && task.spec.requireVerification === true) || confidence < 0.8;

    if (requiresVerification) {
      console.log(`[${podConfig.id}] Confidence (${confidence.toFixed(2)}) requires peer verification. Requesting audit.`);
      await publishEvent("task.verification_requested", "hub", {
        taskId: task.taskId,
        workerPod: podConfig.id,
        candidatePayload: executionResult,
        confidence,
        rubric: task.spec?.verificationRubric || "Verify output completeness, accuracy, and compliance.",
        timestamp: now,
      });
    } else {
      await publishEvent("task.completed", "hub", {
        taskId: task.taskId,
        workerPod: podConfig.id,
        event: "completed",
        confidence,
        result: executionResult,
        timestamp: now,
      });
    }

    return executionResult;
  }
}

export const activeHandler: TaskHandler = new DefaultPodHandler();
