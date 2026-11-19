#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const paddingSeconds = 0.18; // Director reserves 130 ms of placement room and 50 ms for fitting.
const speedLimit = 1.25;
const usage = 'Usage: node bin/check-script-pacing.mjs shots.json timings.json';

function readArray(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path}: expected a JSON array`);
  return value;
}

function check(shots, timings) {
  if (shots.length === 0) throw new Error('No shots in manifest');
  const byShot = new Map();
  for (const take of timings) {
    const shot = take?.shot;
    if (!Number.isInteger(shot) || shot < 1 || shot > shots.length || byShot.has(shot)) {
      throw new Error(`Unknown or duplicate timing shot: ${shot}`);
    }
    byShot.set(shot, take);
  }

  const rewrite = [];
  const missing = [];
  let maxSpeed = null;
  let previousEnd = 0;
  for (const [index, scene] of shots.entries()) {
    const shot = index + 1;
    const { start, end, vo } = scene ?? {};
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || typeof vo !== 'string') {
      throw new Error(`Shot ${shot}: expected ordered, non-overlapping times in seconds and string vo`);
    }
    previousEnd = end;
    const take = byShot.get(shot);
    if (!vo.trim()) {
      if (take) throw new Error(`Shot ${shot}: unexpected narration timing for a silent shot`);
      continue;
    }
    const availableSeconds = end - start - paddingSeconds;
    if (availableSeconds <= 0) throw new Error(`Shot ${shot}: voiced slot must exceed ${paddingSeconds}s padding`);
    if (take && take.vo !== vo) throw new Error(`Shot ${shot}: timing text does not match the current vo`);
    const naturalSeconds = take?.naturalSeconds ?? take?.nativeSeconds;
    if (naturalSeconds == null) {
      missing.push({ shot, vo });
      continue;
    }
    if (!Number.isFinite(naturalSeconds) || naturalSeconds <= 0) {
      throw new Error(`Shot ${shot}: measured natural duration must be a positive finite number`);
    }
    const requiredSpeed = Math.max(1, naturalSeconds / availableSeconds);
    maxSpeed = Math.max(maxSpeed ?? 0, requiredSpeed);
    const maxNaturalSeconds = availableSeconds * speedLimit;
    // Account for subtraction of floating-point time offsets at the inclusive boundary.
    if (naturalSeconds - maxNaturalSeconds > Number.EPSILON * Math.max(1, end, naturalSeconds) * 4) {
      rewrite.push({ shot, vo, naturalSeconds, availableSeconds, requiredSpeed, maxNaturalSeconds });
    }
  }

  const status = missing.length ? 'unknown' : rewrite.length ? 'needs_rewrite' : 'pass';
  return { status, speedLimit, paddingSeconds, maxSpeed, rewrite, missing };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else {
  try {
    if (args.length !== 2) throw new Error(usage);
    const report = check(readArray(args[0]), readArray(args[1]));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = { pass: 0, needs_rewrite: 1, unknown: 2 }[report.status];
  } catch (error) {
    console.log(JSON.stringify({ status: 'invalid', error: error.message }));
    process.exitCode = 2;
  }
}
