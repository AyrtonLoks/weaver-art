import type { WeaveResult } from './types.js';

export interface EstimateOptions {
  /** Seconds per laid chord for hand weaving (default: 6). */
  secondsPerChord?: number;
  /** Seconds per tie-on of a new thread spool/color (default: 120). */
  secondsPerTieOn?: number;
  /** Seconds per switch between already tied threads (default: 10). */
  secondsPerSwitch?: number;
  /** Safety margin percentage added to thread length (default: 10). */
  safetyMarginPct?: number;
  /** Tail allowance in mm per tied thread for knots/ties (default: 300). */
  tailMmPerThread?: number;
  /** Length of a spool in meters, global or by thread id (default: 1000). */
  spoolLengthM?: number | Record<string, number>;
  /** CNC/plotter feedrate in mm/min for machine weaving time estimation. */
  machineFeedMmPerMin?: number;
}

export interface ThreadEstimate {
  id: string;
  name: string;
  color: string;
  lines: number;
  lengthMm: number;
  requiredMm: number;
  spools: number;
  spoolUsagePct: number;
}

export interface WeaveEstimate {
  chords: number;
  tieOns: number;
  switches: number;
  weavingSeconds: number;
  overheadSeconds: number;
  totalSeconds: number;
  threads: ThreadEstimate[];
  totalRequiredMm: number;
  machineSeconds?: number;
}

/**
 * Estimate manual weaving time, machine time, thread consumption, and spools needed.
 *
 * @param result   The finished weave result.
 * @param opts     Estimation configuration parameters.
 * @param fromStep Starting step index (default 0; >0 gives remaining time for player).
 */
export function estimateWeave(result: WeaveResult, opts: EstimateOptions = {}, fromStep = 0): WeaveEstimate {
  const steps = fromStep > 0 ? result.steps.slice(fromStep) : result.steps;
  const chords = steps.length;

  const secPerChord = opts.secondsPerChord ?? 6;
  const secTieOn = opts.secondsPerTieOn ?? 120;
  const secSwitch = opts.secondsPerSwitch ?? 10;
  const marginPct = opts.safetyMarginPct ?? 10;
  const tailMm = opts.tailMmPerThread ?? 300;

  let tieOns = 0;
  let switches = 0;
  let prevThread = -1;
  const seenThreads = new Set<number>();

  for (const s of steps) {
    if (s.thread !== prevThread) {
      if (!seenThreads.has(s.thread)) {
        tieOns++;
        seenThreads.add(s.thread);
      } else {
        switches++;
      }
      prevThread = s.thread;
    }
  }

  const weavingSeconds = chords * secPerChord;
  const overheadSeconds = tieOns * secTieOn + switches * secSwitch;
  const totalSeconds = weavingSeconds + overheadSeconds;

  const threadConfigs = result.options.threads;
  const threads: ThreadEstimate[] = threadConfigs.map((t, tIdx) => {
    let lines = 0;
    let lengthMm = 0;
    for (const s of steps) {
      if (s.thread === tIdx) {
        lines++;
        lengthMm += s.segmentMm + s.wrapMm;
      }
    }

    const requiredMm = lines > 0 ? lengthMm * (1 + marginPct / 100) + tailMm : 0;

    let spoolLengthM = 1000;
    if (opts.spoolLengthM !== undefined) {
      if (typeof opts.spoolLengthM === 'number') {
        spoolLengthM = opts.spoolLengthM;
      } else if (opts.spoolLengthM[t.id] !== undefined) {
        spoolLengthM = opts.spoolLengthM[t.id];
      }
    }
    const spoolLengthMm = Math.max(1, spoolLengthM * 1000);
    const spools = Math.ceil(requiredMm / spoolLengthMm);
    const spoolUsagePct = spools > 0 ? (requiredMm / (spools * spoolLengthMm)) * 100 : 0;

    return {
      id: t.id,
      name: t.name,
      color: t.color,
      lines,
      lengthMm,
      requiredMm,
      spools,
      spoolUsagePct,
    };
  });

  const totalRequiredMm = threads.reduce((sum, t) => sum + t.requiredMm, 0);

  let machineSeconds: number | undefined;
  if (opts.machineFeedMmPerMin && opts.machineFeedMmPerMin > 0) {
    const totalPathMm = steps.reduce((sum, s) => sum + s.segmentMm + s.wrapMm, 0);
    machineSeconds = Math.round((totalPathMm / opts.machineFeedMmPerMin) * 60);
  }

  return {
    chords,
    tieOns,
    switches,
    weavingSeconds,
    overheadSeconds,
    totalSeconds,
    threads,
    totalRequiredMm,
    machineSeconds,
  };
}

/**
 * Format a duration in seconds into a friendly human string (e.g. "6 h 47 min" or "45 s").
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}
