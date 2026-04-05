/**
 * PRD Readiness Gate — stateless, idempotent evaluation of PRD completeness.
 * ESM module, pure functions (except synthesize/decomposeTickets which do file I/O).
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_SECTIONS = [
  'Problem Statement',
  'Goals & Non-Goals',
  'User Stories',
  'Requirements',
  'Interface Contracts',
  'Acceptance Criteria',
  'Architecture',
  'Security Considerations',
  'Testing Strategy',
];

const TABLE_SECTIONS = new Set(['Requirements', 'Acceptance Criteria']);

/**
 * Scan a PRD for required sections.
 * Returns Record<string, 'FULL'|'PARTIAL'|'MISSING'>.
 */
export function scanSections(prdText) {
  const result = {};
  for (const section of REQUIRED_SECTIONS) {
    const headingRe = new RegExp(`^##\\s+${escapeRegex(section)}`, 'im');
    if (!headingRe.test(prdText)) {
      result[section] = 'MISSING';
      continue;
    }
    if (TABLE_SECTIONS.has(section)) {
      const sectionContent = extractSectionContent(prdText, section);
      const hasTable = /\|.*\|/.test(sectionContent);
      const hasVerifyCol = /\|\s*Verify\s*\|/i.test(sectionContent);
      result[section] = hasTable && hasVerifyCol ? 'FULL' : 'PARTIAL';
    } else {
      result[section] = 'FULL';
    }
  }
  return result;
}

/**
 * Scan PRD quality aspects.
 * Returns Record<string, 'PASS'|'NEEDS_WORK'>.
 */
export function scanQuality(prdText) {
  const contractsSection = extractSectionContent(prdText, 'Interface Contracts');
  const hasContracts = /^##\s+Interface Contracts/im.test(prdText);
  const contractsTbd = hasContracts && /\bTBD\b/.test(contractsSection);

  const reqSection = extractSectionContent(prdText, 'Requirements');
  const acSection = extractSectionContent(prdText, 'Acceptance Criteria');
  const reqHasVerify = !reqSection || /\|\s*Verify\s*\|/i.test(reqSection);
  const acHasVerify = !acSection || /\|\s*Verify\s*\|/i.test(acSection);
  const verificationOk = reqHasVerify && acHasVerify;

  return {
    contracts: contractsTbd ? 'NEEDS_WORK' : 'PASS',
    verification: verificationOk ? 'PASS' : 'NEEDS_WORK',
  };
}

/**
 * Evaluate the PRD readiness gate.
 * Returns { decision: 'PASS'|'NEEDS_WORK', sections, quality, gaps: string[] }.
 */
export function evaluateGate(prdText) {
  const sections = scanSections(prdText);
  const quality = scanQuality(prdText);
  const gaps = [];

  for (const [name, status] of Object.entries(sections)) {
    if (status === 'MISSING') gaps.push(`Section "${name}" is missing`);
    if (status === 'PARTIAL') gaps.push(`Section "${name}" is incomplete — missing verification column`);
  }
  for (const [aspect, status] of Object.entries(quality)) {
    if (status === 'NEEDS_WORK') {
      if (aspect === 'contracts') gaps.push('Interface Contracts contain TBD placeholders');
      if (aspect === 'verification') gaps.push('Requirements/AC tables missing Verify column');
    }
  }

  const allFull = Object.values(sections).every(s => s === 'FULL');
  const allPass = Object.values(quality).every(q => q === 'PASS');
  const decision = allFull && allPass ? 'PASS' : 'NEEDS_WORK';

  return { decision, sections, quality, gaps };
}

/**
 * Synthesize a refined PRD from original PRD + analysis files.
 * Reads analysis_*.md from analysisDir, merges gaps/enhancements into PRD with attribution.
 */
export async function synthesize({ prdPath, analysisDir, outputPath }) {
  const prdText = fs.readFileSync(prdPath, 'utf-8');
  const analysisFiles = fs.readdirSync(analysisDir)
    .filter(f => f.startsWith('analysis_') && f.endsWith('.md'))
    .sort();

  const analyses = analysisFiles.map(f => {
    const content = fs.readFileSync(path.join(analysisDir, f), 'utf-8');
    const source = f.replace(/^analysis_/, '').replace(/\.md$/, '');
    return { source, ...parseAnalysis(content) };
  });

  const lines = prdText.split('\n');
  const additions = [];

  for (const analysis of analyses) {
    for (const gap of analysis.gaps) {
      additions.push(`- ${gap.detail} *(refined: ${analysis.source})*`);
    }
    for (const enh of analysis.enhancements) {
      additions.push(`- ${enh} *(refined: ${analysis.source})*`);
    }
  }

  const output = [
    ...lines,
    '',
    '## Refinement Notes',
    ...additions,
  ].join('\n');

  fs.writeFileSync(outputPath, output);
}

/**
 * Decompose a refined PRD into self-contained tickets.
 * Returns array of { id, path, files, fileCount }.
 */
export async function decomposeTickets({ prdPath, outputDir }) {
  const prdText = fs.readFileSync(prdPath, 'utf-8');
  const requirements = extractRequirements(prdText);

  if (requirements.length === 0) {
    requirements.push({
      id: 'ticket-001',
      requirement: extractFirstHeading(prdText) || 'Implementation',
      verify: 'node --test',
    });
  }

  const tickets = requirements.map((req, i) => {
    const id = `ticket-${String(i + 1).padStart(3, '0')}`;
    const files = ['lib/prd-gate.js', `tests/prd-pipeline.test.js`];
    const content = [
      `# ${id}: ${req.requirement}`,
      '',
      '## Description',
      `Implement: ${req.requirement}`,
      '',
      '## Research Seeds',
      `- Trace existing implementation patterns in \`lib/\``,
      `- Review test expectations in \`tests/prd-pipeline.test.js\``,
      '',
      '## Acceptance Criteria',
      '| # | Criterion | Verify |',
      '|---|---|---|',
      `| 1 | ${req.requirement} | \`${req.verify || 'node --test'}\` |`,
      '',
      '## Files',
      ...files.map(f => `- ${f}`),
    ].join('\n');

    const ticketPath = path.join(outputDir, `${id}.md`);
    fs.writeFileSync(ticketPath, content);
    return { id, path: ticketPath, files, fileCount: files.length };
  });

  return tickets;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionContent(prdText, sectionName) {
  const re = new RegExp(`^##\\s+${escapeRegex(sectionName)}[^\\n]*\\n`, 'im');
  const match = re.exec(prdText);
  if (!match) return '';
  const start = match.index + match[0].length;
  const nextHeading = prdText.slice(start).search(/^##\s/m);
  return nextHeading === -1 ? prdText.slice(start) : prdText.slice(start, start + nextHeading);
}

function parseAnalysis(content) {
  const gaps = [];
  const enhancements = [];
  const gapsMatch = content.match(/## Gaps\n([\s\S]*?)(?=\n##|$)/);
  if (gapsMatch) {
    for (const line of gapsMatch[1].split('\n')) {
      const m = line.match(/^- \[(\w+)\]\s+([^:]+):\s+(.+)/);
      if (m) gaps.push({ priority: m[1], section: m[2], detail: m[3] });
    }
  }
  const enhMatch = content.match(/## Enhancements\n([\s\S]*?)(?=\n##|$)/);
  if (enhMatch) {
    for (const line of enhMatch[1].split('\n')) {
      if (line.startsWith('- ')) enhancements.push(line.slice(2));
    }
  }
  return { gaps, enhancements };
}

function extractRequirements(prdText) {
  const section = extractSectionContent(prdText, 'Requirements');
  if (!section) return [];
  const rows = section.split('\n').filter(l => /^\|/.test(l.trim()));
  if (rows.length < 3) return [];
  const header = rows[0];
  const cols = header.split('|').map(c => c.trim()).filter(Boolean);
  const reqIdx = cols.findIndex(c => /requirement/i.test(c));
  const verIdx = cols.findIndex(c => /verify/i.test(c));

  return rows.slice(2).map(row => {
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    return {
      requirement: cells[reqIdx] || 'Implementation task',
      verify: cells[verIdx] || 'node --test',
    };
  }).filter(r => r.requirement);
}

function extractFirstHeading(text) {
  const m = text.match(/^#\s+(.+)/m);
  return m ? m[1] : null;
}
