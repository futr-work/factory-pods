import { PodStorage } from "@futr-work/pod-kernel/storage";
import { EpisodeRecord, BeliefRecord, ConsolidationSummary } from "./types.js";

/**
 * ============================================================================
 * COGNITIVE SLEEP & CONSOLIDATION ENGINE
 * ============================================================================
 * Replays recent episodes during pod idle / sleep cycles, decays stale beliefs,
 * and synthesizes semantic principles into the beliefs table.
 */
export async function runSleepConsolidation(
  db: PodStorage,
  domain: string,
  now: number = Date.now()
): Promise<ConsolidationSummary> {
  let beliefsDecayed = 0;
  let beliefsSynthesized = 0;
  let habitsCompiled = 0;

  // 1. Decay expired beliefs (pruning stale cognitive state)
  try {
    const decayRes = await db.prepare(`
      DELETE FROM beliefs WHERE expires_at IS NOT NULL AND expires_at < ?
    `).bind(now).run();
    beliefsDecayed = decayRes?.meta?.changes || 0;
  } catch (err) {
    console.warn("[consolidation] Failed to decay expired beliefs:", err);
  }

  // 2. Fetch recent successful episodes for this domain (last 24 hours, confidence >= 0.85)
  const windowStart = now - 24 * 60 * 60 * 1000;
  let recentEpisodes: EpisodeRecord[] = [];
  try {
    const res = await db.prepare(`
      SELECT * FROM episodes 
      WHERE created_at >= ? AND confidence >= 0.85
      ORDER BY created_at DESC LIMIT 50
    `).bind(windowStart).all<any>();

    recentEpisodes = (res?.results || []).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      topic: r.topic,
      specSummary: r.spec_summary,
      actionTaken: r.action_taken,
      outcome: r.outcome,
      confidence: r.confidence,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.warn("[consolidation] Failed to load episodes:", err);
  }

  // 3. Cluster episodes by topic to synthesize semantic beliefs
  const topicGroups = new Map<string, EpisodeRecord[]>();
  for (const ep of recentEpisodes) {
    const group = topicGroups.get(ep.topic) || [];
    group.push(ep);
    topicGroups.set(ep.topic, group);
  }

  for (const [topic, eps] of topicGroups.entries()) {
    if (eps.length >= 2) {
      // Multiple verified episodes on this topic form a semantic belief
      const avgConfidence = eps.reduce((sum, e) => sum + e.confidence, 0) / eps.length;
      const beliefId = `belief_${domain}_${topic.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const claim = `Topic '${topic}' in domain '${domain}' reliably resolves using ${eps[0].actionTaken} (verified across ${eps.length} runs).`;
      const sourceEpisodeIds = JSON.stringify(eps.map((e) => e.taskId));
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7-day half-life before re-verification

      try {
        await db.prepare(`
          INSERT INTO beliefs (id, domain, claim, confidence, evidence_count, source_episodes_json, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            claim = excluded.claim,
            confidence = (beliefs.confidence * beliefs.evidence_count + excluded.confidence * ?) / (beliefs.evidence_count + ?),
            evidence_count = beliefs.evidence_count + ?,
            source_episodes_json = excluded.source_episodes_json,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `).bind(
          beliefId, domain, claim, avgConfidence, eps.length, sourceEpisodeIds, expiresAt, now, now,
          eps.length, eps.length, eps.length
        ).run();

        beliefsSynthesized++;
      } catch (insertErr) {
        console.warn(`[consolidation] Failed to upsert belief for topic ${topic}:`, insertErr);
      }

      // If confidence is >= 0.95 across >= 5 runs, flag as compiled habit candidate
      if (avgConfidence >= 0.95 && eps.length >= 5) {
        habitsCompiled++;
      }
    }
  }

  return {
    episodesAnalyzed: recentEpisodes.length,
    beliefsSynthesized,
    beliefsDecayed,
    habitsCompiled,
    timestamp: now,
  };
}
