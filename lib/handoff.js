/**
 * Handoff — generates markdown handoff files for ticket transitions.
 *
 * Used by tmux-runner and microverse-runner to record iteration state
 * (SHA, diff stats, status) when handing off between workers.
 * ESM module, zero dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build a markdown handoff string from options.
 * @param {object} opts
 * @param {string} [opts.ticket] - Ticket ID
 * @param {string} [opts.sha] - Git commit SHA
 * @param {string} [opts.diffStat] - Output of git diff --stat
 * @param {string} [opts.status] - Current status
 * @param {string} [opts.timestamp] - ISO timestamp (defaults to now)
 * @returns {string} Markdown content
 */
export function buildHandoff(opts = {}) {
  const ts = opts.timestamp || new Date().toISOString();
  const lines = [
    '# Handoff',
    '',
    `**Ticket:** ${opts.ticket || 'N/A'}`,
    `**SHA:** ${opts.sha || 'N/A'}`,
    `**Status:** ${opts.status || 'N/A'}`,
    `**Timestamp:** ${ts}`,
  ];

  if (opts.diffStat) {
    lines.push('', '## Diff Stats', '```', opts.diffStat, '```');
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
