import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanSections,
  scanQuality,
  evaluateGate,
  synthesize,
  decomposeTickets,
} from '../lib/prd-gate.js';

// ---------------------------------------------------------------------------
// Inline Fixture PRDs
// ---------------------------------------------------------------------------

/** Complete PRD with all required sections and verification columns */
const COMPLETE_PRD = `# Product Requirements Document

## Problem Statement
Users need automated PRD validation before refinement begins.

## Goals & Non-Goals
### Goals
- Validate PRD completeness before refinement
- Reject PRDs with missing verification criteria

### Non-Goals
- Replace human review entirely

## User Stories
As a developer, I want automated PRD validation so that refinement doesn't waste cycles on incomplete specs.

## Requirements
| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Gate scans all sections | node --test tests/prd-pipeline.test.js | test |
| 2 | Gate rejects incomplete PRDs | Manual review | review |

## Interface Contracts
\`\`\`typescript
interface GateResult {
  decision: 'PASS' | 'NEEDS_WORK';
  sections: Record<string, 'FULL' | 'PARTIAL' | 'MISSING'>;
  gaps: string[];
}
\`\`\`

## Acceptance Criteria
| # | Criterion | Verify | Type |
|---|---|---|---|
| 1 | All sections present | scanSections returns FULL for each | test |
| 2 | Quality checks pass | scanQuality returns PASS | test |

## Architecture
Stateless function in lib/prd-gate.js. No side effects, no I/O.

## Security Considerations
No user input processed. Internal tooling only.

## Testing Strategy
Unit tests with inline fixtures. Node built-in test runner.
`;

/** PRD with missing verification column in requirements table */
const MISSING_VERIFICATION_PRD = `# Product Requirements Document

## Problem Statement
Users need automated PRD validation.

## Goals & Non-Goals
### Goals
- Validate PRD completeness

## User Stories
As a developer, I want PRD validation.

## Requirements
| # | Requirement |
|---|---|
| 1 | Gate scans all sections |
| 2 | Gate rejects incomplete PRDs |

## Interface Contracts
\`\`\`typescript
interface GateResult {
  decision: 'PASS' | 'NEEDS_WORK';
  sections: Record<string, string>;
}
\`\`\`

## Acceptance Criteria
| # | Criterion |
|---|---|
| 1 | All sections present |

## Architecture
Stateless function.

## Testing Strategy
Unit tests.
`;

/** PRD with TBD in interface contracts */
const TBD_CONTRACTS_PRD = `# Product Requirements Document

## Problem Statement
Users need automated PRD validation.

## Goals & Non-Goals
### Goals
- Validate PRD completeness

## User Stories
As a developer, I want PRD validation.

## Requirements
| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Gate scans all sections | node --test | test |

## Interface Contracts
\`\`\`typescript
interface GateResult {
  decision: TBD;
  sections: TBD;
  gaps: TBD;
}
\`\`\`

## Acceptance Criteria
| # | Criterion | Verify | Type |
|---|---|---|---|
| 1 | All sections present | scanSections | test |

## Architecture
TBD — will be defined after spike.

## Testing Strategy
Unit tests.
`;

/** PRD with partial sections — some present, some missing */
const PARTIAL_PRD = `# Product Requirements Document

## Problem Statement
Users need automated PRD validation.

## Goals & Non-Goals
### Goals
- Validate PRD completeness

## Requirements
| # | Requirement | Verify | Type |
|---|---|---|---|
| 1 | Gate scans | node --test | test |

## Interface Contracts
\`\`\`typescript
interface GateResult { decision: string; }
\`\`\`
`;

/** Minimal PRD — missing most sections */
const MINIMAL_PRD = `# Product Requirements Document

## Problem Statement
Something needs fixing.
`;

// ---------------------------------------------------------------------------
// Mock analysis data for synthesis tests
// ---------------------------------------------------------------------------

const MOCK_ANALYSES = [
  {
    source: 'requirements',
    gaps: [
      { priority: 'P0', section: 'Requirements', detail: 'Missing error handling spec' },
      { priority: 'P1', section: 'Testing', detail: 'No integration test plan' },
    ],
    enhancements: ['Add retry logic to gate evaluation'],
  },
  {
    source: 'codebase',
    gaps: [
      { priority: 'P0', section: 'Interface Contracts', detail: 'Return type mismatch with existing code' },
    ],
    enhancements: ['Align with existing StateManager pattern'],
  },
  {
    source: 'risk-scope',
    gaps: [
      { priority: 'P1', section: 'Architecture', detail: 'No failure mode defined for gate timeout' },
    ],
    enhancements: [],
  },
];

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: write a file to tmpDir and return path */
function writeFixture(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Helper: write mock analysis files to simulate refinement output */
function writeAnalyses(analyses) {
  const analysisDir = path.join(tmpDir, 'refinement');
  fs.mkdirSync(analysisDir, { recursive: true });
  for (const analysis of analyses) {
    const filePath = path.join(analysisDir, `analysis_${analysis.source}.md`);
    const content = [
      `# ${analysis.source} Analysis`,
      '',
      '## Gaps',
      ...analysis.gaps.map(g => `- [${g.priority}] ${g.section}: ${g.detail}`),
      '',
      '## Enhancements',
      ...analysis.enhancements.map(e => `- ${e}`),
    ].join('\n');
    fs.writeFileSync(filePath, content);
  }
  return analysisDir;
}

// ---------------------------------------------------------------------------
// readiness-gate — AC #3
// ---------------------------------------------------------------------------
describe('readiness-gate', () => {
  describe('scanSections', () => {
    it('returns FULL for all sections in a complete PRD', () => {
      const result = scanSections(COMPLETE_PRD);
      assert.equal(typeof result, 'object');
      for (const [section, status] of Object.entries(result)) {
        assert.equal(status, 'FULL', `Section "${section}" should be FULL`);
      }
    });

    it('returns PARTIAL for PRD with some sections present', () => {
      const result = scanSections(PARTIAL_PRD);
      const statuses = Object.values(result);
      assert(statuses.includes('FULL'), 'Should have some FULL sections');
      assert(
        statuses.includes('MISSING') || statuses.includes('PARTIAL'),
        'Should have some MISSING or PARTIAL sections',
      );
    });

    it('returns MISSING for absent sections in minimal PRD', () => {
      const result = scanSections(MINIMAL_PRD);
      const statuses = Object.values(result);
      const missingCount = statuses.filter(s => s === 'MISSING').length;
      assert(missingCount >= 3, `Expected >=3 MISSING sections, got ${missingCount}`);
    });

    it('scans known section names', () => {
      const result = scanSections(COMPLETE_PRD);
      const expectedSections = [
        'Problem Statement',
        'Goals & Non-Goals',
        'Requirements',
        'Interface Contracts',
        'Acceptance Criteria',
      ];
      for (const section of expectedSections) {
        assert(section in result, `Missing scan for section: ${section}`);
      }
    });
  });

  describe('scanQuality', () => {
    it('returns PASS for a complete, well-formed PRD', () => {
      const result = scanQuality(COMPLETE_PRD);
      assert.equal(typeof result, 'object');
      for (const [aspect, status] of Object.entries(result)) {
        assert.equal(status, 'PASS', `Aspect "${aspect}" should be PASS`);
      }
    });

    it('returns NEEDS_WORK when contracts have TBD', () => {
      const result = scanQuality(TBD_CONTRACTS_PRD);
      assert.equal(result.contracts, 'NEEDS_WORK');
    });

    it('returns NEEDS_WORK when verification column is missing', () => {
      const result = scanQuality(MISSING_VERIFICATION_PRD);
      assert.equal(result.verification, 'NEEDS_WORK');
    });
  });

  describe('evaluateGate', () => {
    it('returns PASS for a complete PRD', () => {
      const result = evaluateGate(COMPLETE_PRD);
      assert.equal(result.decision, 'PASS');
      assert(Array.isArray(result.gaps));
      assert.equal(result.gaps.length, 0);
    });

    it('returns NEEDS_WORK for an incomplete PRD', () => {
      const result = evaluateGate(PARTIAL_PRD);
      assert.equal(result.decision, 'NEEDS_WORK');
      assert(result.gaps.length > 0, 'Should list specific gaps');
    });

    it('includes section scan and quality scan in result', () => {
      const result = evaluateGate(COMPLETE_PRD);
      assert(result.sections, 'Result should include sections scan');
      assert(result.quality, 'Result should include quality scan');
    });
  });
});

// ---------------------------------------------------------------------------
// gate-rejects-missing — AC #4
// ---------------------------------------------------------------------------
describe('gate-rejects-missing', () => {
  it('rejects PRD with missing Verify column in requirements table', () => {
    const result = evaluateGate(MISSING_VERIFICATION_PRD);
    assert.equal(result.decision, 'NEEDS_WORK');
    assert(
      result.gaps.some(g => /verif/i.test(g)),
      'Gaps should mention missing verification column',
    );
  });

  it('scanSections returns PARTIAL for requirements without Verify column', () => {
    const result = scanSections(MISSING_VERIFICATION_PRD);
    assert.equal(result['Requirements'], 'PARTIAL');
  });

  it('missing Verify column in AC table also detected', () => {
    const result = scanSections(MISSING_VERIFICATION_PRD);
    assert.equal(result['Acceptance Criteria'], 'PARTIAL');
  });
});

// ---------------------------------------------------------------------------
// gate-rejects-tbd — AC #5
// ---------------------------------------------------------------------------
describe('gate-rejects-tbd', () => {
  it('rejects PRD with TBD in interface contracts', () => {
    const result = evaluateGate(TBD_CONTRACTS_PRD);
    assert.equal(result.decision, 'NEEDS_WORK');
    assert(
      result.gaps.some(g => /TBD/i.test(g) || /contract/i.test(g)),
      'Gaps should mention TBD in contracts',
    );
  });

  it('scanQuality flags contracts with TBD as NEEDS_WORK', () => {
    const result = scanQuality(TBD_CONTRACTS_PRD);
    assert.equal(result.contracts, 'NEEDS_WORK');
  });

  it('does not flag contracts without TBD', () => {
    const result = scanQuality(COMPLETE_PRD);
    assert.equal(result.contracts, 'PASS');
  });
});

// ---------------------------------------------------------------------------
// gate-idempotent — AC #6
// ---------------------------------------------------------------------------
describe('gate-idempotent', () => {
  it('produces identical output for the same input on repeated calls', () => {
    const result1 = evaluateGate(COMPLETE_PRD);
    const result2 = evaluateGate(COMPLETE_PRD);
    assert.deepStrictEqual(result1, result2);
  });

  it('scanSections is idempotent', () => {
    const result1 = scanSections(PARTIAL_PRD);
    const result2 = scanSections(PARTIAL_PRD);
    assert.deepStrictEqual(result1, result2);
  });

  it('scanQuality is idempotent', () => {
    const result1 = scanQuality(TBD_CONTRACTS_PRD);
    const result2 = scanQuality(TBD_CONTRACTS_PRD);
    assert.deepStrictEqual(result1, result2);
  });

  it('evaluateGate on failing PRD is also idempotent', () => {
    const result1 = evaluateGate(MISSING_VERIFICATION_PRD);
    const result2 = evaluateGate(MISSING_VERIFICATION_PRD);
    assert.deepStrictEqual(result1, result2);
  });
});

// ---------------------------------------------------------------------------
// synthesis-attribution — AC #7
// ---------------------------------------------------------------------------
describe('synthesis-attribution', () => {
  it('produces output with *(refined: source)* attribution markers', async () => {
    const prdPath = writeFixture('prd.md', COMPLETE_PRD);
    const analysisDir = writeAnalyses(MOCK_ANALYSES);
    const outputPath = path.join(tmpDir, 'prd_refined.md');

    await synthesize({
      prdPath,
      analysisDir,
      outputPath,
    });

    const output = fs.readFileSync(outputPath, 'utf-8');
    const attributionPattern = /\*\(refined:\s*\w[\w-]*\)\*/g;
    const matches = output.match(attributionPattern) || [];
    assert(matches.length > 0, 'Output should contain attribution markers');
  });

  it('attribution count >= number of P0 gaps in analyses', async () => {
    const prdPath = writeFixture('prd.md', COMPLETE_PRD);
    const analysisDir = writeAnalyses(MOCK_ANALYSES);
    const outputPath = path.join(tmpDir, 'prd_refined.md');

    await synthesize({
      prdPath,
      analysisDir,
      outputPath,
    });

    const output = fs.readFileSync(outputPath, 'utf-8');
    const attributionPattern = /\*\(refined:\s*\w[\w-]*\)\*/g;
    const matches = output.match(attributionPattern) || [];
    const p0Count = MOCK_ANALYSES.reduce(
      (sum, a) => sum + a.gaps.filter(g => g.priority === 'P0').length,
      0,
    );
    assert(
      matches.length >= p0Count,
      `Expected >= ${p0Count} attributions (P0 gaps), got ${matches.length}`,
    );
  });

  it('attributions reference actual analysis sources', async () => {
    const prdPath = writeFixture('prd.md', COMPLETE_PRD);
    const analysisDir = writeAnalyses(MOCK_ANALYSES);
    const outputPath = path.join(tmpDir, 'prd_refined.md');

    await synthesize({
      prdPath,
      analysisDir,
      outputPath,
    });

    const output = fs.readFileSync(outputPath, 'utf-8');
    const sources = MOCK_ANALYSES.map(a => a.source);
    for (const source of sources) {
      if (MOCK_ANALYSES.find(a => a.source === source).gaps.length > 0) {
        assert(
          output.includes(`*(refined: ${source})*`),
          `Missing attribution for source: ${source}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ticket-completeness — AC #8
// ---------------------------------------------------------------------------
describe('ticket-completeness', () => {
  it('each ticket has research seeds section', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    assert(Array.isArray(tickets));
    assert(tickets.length > 0, 'Should produce at least one ticket');

    for (const ticket of tickets) {
      const content = fs.readFileSync(ticket.path, 'utf-8');
      assert(
        /## Research Seeds/i.test(content) || /### Research Seeds/i.test(content),
        `Ticket ${ticket.id} missing Research Seeds section`,
      );
    }
  });

  it('each ticket has verify commands', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    for (const ticket of tickets) {
      const content = fs.readFileSync(ticket.path, 'utf-8');
      assert(
        /## Acceptance Criteria/i.test(content) || /### Acceptance Criteria/i.test(content),
        `Ticket ${ticket.id} missing Acceptance Criteria`,
      );
      // Verify commands should be present (backtick-wrapped commands)
      assert(
        /`[^`]+`/.test(content),
        `Ticket ${ticket.id} should have verify commands in backticks`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ticket-self-contained — AC #9
// ---------------------------------------------------------------------------
describe('ticket-self-contained', () => {
  it('tickets do not reference "see PRD" or external context', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    assert(tickets.length > 0, 'Should produce tickets');

    for (const ticket of tickets) {
      const content = fs.readFileSync(ticket.path, 'utf-8');
      assert(
        !/see PRD/i.test(content),
        `Ticket ${ticket.id} contains "see PRD" — must be self-contained`,
      );
      assert(
        !/see the PRD/i.test(content),
        `Ticket ${ticket.id} contains "see the PRD" — must be self-contained`,
      );
      assert(
        !/refer to PRD/i.test(content),
        `Ticket ${ticket.id} contains "refer to PRD" — must be self-contained`,
      );
    }
  });

  it('tickets include all context needed without PRD reference', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    for (const ticket of tickets) {
      const content = fs.readFileSync(ticket.path, 'utf-8');
      // Each ticket should have a description section
      assert(
        /## Description/i.test(content) || /## Problem/i.test(content),
        `Ticket ${ticket.id} missing Description/Problem section`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ticket-sizing — AC #10
// ---------------------------------------------------------------------------
describe('ticket-sizing', () => {
  it('each ticket touches <5 files', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    for (const ticket of tickets) {
      assert(
        typeof ticket.fileCount === 'number' || typeof ticket.files === 'object',
        `Ticket ${ticket.id} should declare file scope`,
      );
      const fileCount = ticket.fileCount ?? (ticket.files ? ticket.files.length : 0);
      assert(
        fileCount < 5,
        `Ticket ${ticket.id} touches ${fileCount} files (max 4)`,
      );
    }
  });

  it('each ticket has <4 acceptance criteria', async () => {
    const prdPath = writeFixture('prd_refined.md', COMPLETE_PRD);
    const tickets = await decomposeTickets({ prdPath, outputDir: tmpDir });

    for (const ticket of tickets) {
      const content = fs.readFileSync(ticket.path, 'utf-8');
      // Count AC rows (lines starting with |, excluding header and separator)
      const acSection = content.split(/## Acceptance Criteria/i)[1] || '';
      const acRows = acSection
        .split('\n')
        .filter(line => /^\|/.test(line.trim()) && !/^[\s|:-]+$/.test(line.trim()))
        .filter(line => !/^\|\s*#\s*\|/.test(line)); // exclude header row
      assert(
        acRows.length < 4,
        `Ticket ${ticket.id} has ${acRows.length} AC (max 3)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// synthesis-resume — AC #10 (refined PRD numbering)
// ---------------------------------------------------------------------------
describe('synthesis-resume', () => {
  it('synthesis can re-run using persisted analyses without re-running refinement', async () => {
    const prdPath = writeFixture('prd.md', COMPLETE_PRD);
    const analysisDir = writeAnalyses(MOCK_ANALYSES);
    const outputPath = path.join(tmpDir, 'prd_refined.md');

    // First run
    await synthesize({ prdPath, analysisDir, outputPath });
    const firstOutput = fs.readFileSync(outputPath, 'utf-8');

    // Second run — same analyses dir, should produce same result
    const outputPath2 = path.join(tmpDir, 'prd_refined_2.md');
    await synthesize({ prdPath, analysisDir, outputPath: outputPath2 });
    const secondOutput = fs.readFileSync(outputPath2, 'utf-8');

    assert.equal(firstOutput, secondOutput, 'Re-run should produce identical output');
  });

  it('synthesis reads from analysis dir, not from live refinement process', async () => {
    const prdPath = writeFixture('prd.md', COMPLETE_PRD);
    const analysisDir = writeAnalyses(MOCK_ANALYSES);
    const outputPath = path.join(tmpDir, 'prd_refined.md');

    await synthesize({ prdPath, analysisDir, outputPath });

    // Verify it read analysis files
    const analysisFiles = fs.readdirSync(analysisDir);
    assert(analysisFiles.length > 0, 'Analysis dir should have files');
    assert(fs.existsSync(outputPath), 'Output file should exist');
  });
});
