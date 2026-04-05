/**
 * Handoff — generates markdown handoff files for ticket transitions.
 *
 * Three variants: base (tmux-runner), microverse, and anatomy park.
 * ESM module, zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

function formatElapsed(startTime) {
  if (!startTime) return 'N/A';
  const ms = Date.now() - startTime;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Build a markdown handoff string with full iteration context.
 * @param {object} opts
 * @param {number} [opts.iteration]
 * @param {string} [opts.step]
 * @param {string} [opts.currentTicket]
 * @param {string} [opts.workingDir]
 * @param {string} [opts.sessionRoot]
 * @param {string[]} [opts.ticketsDone]
 * @param {string[]} [opts.ticketsPending]
 * @param {number} [opts.startTime] - epoch ms
 * @param {string} [opts.instructions]
 * @returns {string} Markdown content
 */
export function buildHandoff(opts = {}) {
  const lines = [
    '# Handoff',
    '',
    `**Iteration:** ${opts.iteration ?? 'N/A'}`,
    `**Phase:** ${opts.step || 'N/A'}`,
    `**Current Ticket:** ${opts.currentTicket || 'N/A'}`,
    `**Working Dir:** ${opts.workingDir || 'N/A'}`,
    `**Session Root:** ${opts.sessionRoot || 'N/A'}`,
    `**Elapsed:** ${formatElapsed(opts.startTime)}`,
    '',
  ];

  const done = opts.ticketsDone || [];
  const pending = opts.ticketsPending || [];

  lines.push('## Progress');
  lines.push(`Done (${done.length}): ${done.join(', ') || 'none'}`);
  lines.push(`Pending (${pending.length}): ${pending.join(', ') || 'none'}`);
  lines.push('');

  if (opts.instructions) {
    lines.push('## Instructions', opts.instructions, '');
  }

  return lines.join('\n');
}

/**
 * Build a microverse handoff with metric context, history, and failed approaches.
 * @param {object} opts - All base opts plus metric, stallCounter, stallLimit, recentHistory, failedApproaches
 * @returns {string} Markdown content
 */
export function buildMicroverseHandoff(opts = {}) {
  const lines = [buildHandoff(opts)];

  const m = opts.metric || {};
  lines.push(
    '## Metric Context',
    `**Description:** ${m.description || 'N/A'}`,
    `**Validation:** ${m.validation || 'N/A'}`,
    `**Direction:** ${m.direction || 'N/A'}`,
    `**Baseline:** ${m.baseline ?? 'N/A'}`,
    `**Current:** ${m.current ?? 'N/A'}`,
    `**Target:** ${m.target ?? 'N/A'}`,
    `**Stall:** ${opts.stallCounter ?? 0} / ${opts.stallLimit ?? 'N/A'}`,
    '',
  );

  const history = (opts.recentHistory || []).slice(-5);
  if (history.length > 0) {
    lines.push('## Recent History');
    for (const h of history) {
      lines.push(`- Iteration ${h.iteration}: ${h.score} (${h.result})`);
    }
    lines.push('');
  }

  const failed = opts.failedApproaches || [];
  if (failed.length > 0) {
    lines.push('## Failed Approaches');
    for (const f of failed) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build an anatomy park handoff with subsystem context.
 * @param {object} opts - All base opts plus subsystem, subsystemIndex, subsystemTotal, passCount, consecutiveClean, previousFindings
 * @returns {string} Markdown content
 */
export function buildAnatomyParkHandoff(opts = {}) {
  const lines = [buildHandoff(opts)];

  lines.push(
    '## Subsystem Context',
    `**Subsystem:** ${opts.subsystem || 'N/A'}`,
    `**Progress:** ${opts.subsystemIndex ?? 'N/A'} / ${opts.subsystemTotal ?? 'N/A'}`,
    `**Pass Count:** ${opts.passCount ?? 0}`,
    `**Consecutive Clean:** ${opts.consecutiveClean ?? 0}`,
  );

  if (opts.previousFindings) {
    lines.push('', '## Previous Findings', opts.previousFindings);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write a handoff.txt file to the specified directory.
 * @param {string} dir - Target directory
 * @param {object} opts - Same options as buildHandoff
 */
export function writeHandoff(dir, opts) {
  fs.writeFileSync(path.join(dir, 'handoff.txt'), buildHandoff(opts));
}
