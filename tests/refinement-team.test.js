import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  spawnRefinementTeam,
  WORKER_ROLES,
  DEFAULT_CYCLES,
  ROLE_AGENTS,
} from '../bin/spawn-refinement-team.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ROLES = ['requirements', 'codebase', 'risk-scope'];

const MOCK_ANALYSIS_CONTENT = {
  requirements: [
    '# Requirements Analysis',
    '',
    '## Critical Gaps (P0)',
    '- [P0] Missing error handling for auth flow',
    '',
    '## Important Gaps (P1)',
    '- [P1] No retry policy for API calls',
    '',
    '## Enhancements',
    '- Add input validation helpers',
  ].join('\n'),
  codebase: [
    '# Codebase Analysis',
    '',
    '## Critical Gaps (P0)',
    '- [P0] Return type mismatch in handler.js:42',
    '',
    '## Important Gaps (P1)',
    '- [P1] Dead code in utils.js:88-120',
    '',
    '## Enhancements',
    '- Align with existing patterns',
  ].join('\n'),
  'risk-scope': [
    '# Risk & Scope Analysis',
    '',
    '## Critical Gaps (P0)',
    '',
    '## Important Gaps (P1)',
    '- [P1] No timeout for external API calls',
    '',
    '## Enhancements',
    '- Add circuit breaker for third-party deps',
  ].join('\n'),
};

const MOCK_ANALYSIS_NO_FINDINGS = {
  requirements: '# Requirements Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n\n## Enhancements\n- Minor style suggestion',
  codebase: '# Codebase Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n\n## Enhancements\n- Consider renaming variable',
  'risk-scope': '# Risk Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n\n## Enhancements\n- No concerns',
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refteam-test-'));
  fs.writeFileSync(path.join(tmpDir, 'prd.md'), '# Test PRD\n\n## Requirements\nSome requirements here.\n');
  fs.mkdirSync(path.join(tmpDir, 'refinement'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build an auto_dump JSON that contains ANALYSIS_DONE token in assistant message.
 */
function buildAutoDump(role, { hasToken = true } = {}) {
  const tokenLine = hasToken ? '<promise>ANALYSIS_DONE</promise>' : '';
  return {
    conversation: {
      context: {
        messages: [
          { text: { role: 'User', content: `Analyze the PRD as ${role} analyst.` } },
          { text: { role: 'Assistant', content: `Analysis complete for ${role}. ${tokenLine}` } },
        ],
      },
    },
  };
}

/**
 * Create a mock forge binary function.
 * When called, writes analysis output and auto_dump to predictable paths.
 */
function createMockForge({ failRole = null, hangRole = null, analysisContent = MOCK_ANALYSIS_CONTENT } = {}) {
  const calls = [];

  const spawnFn = mock.fn((cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 10000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = mock.fn((sig) => {
      child.killed = true;
      if (sig === 'SIGKILL') {
        process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
      }
    });

    // Extract role from --agent flag
    const agentIdx = args.indexOf('--agent');
    const agentArg = agentIdx >= 0 ? args[agentIdx + 1] : '';
    const role = ROLES.find(r => agentArg.includes(r)) || 'unknown';

    // Extract cycle from prompt content
    const promptArg = args.find(a => typeof a === 'string' && a.includes('Cycle')) || '';
    const cycleMatch = promptArg.match(/Cycle\s+(\d+)/);
    const cycle = cycleMatch ? parseInt(cycleMatch[1]) : 1;

    calls.push({ cmd, args, opts, role, cycle, child });

    if (hangRole === role) {
      // Don't emit exit — child hangs
      return child;
    }

    const exitCode = failRole === role ? 1 : 0;

    process.nextTick(() => {
      if (exitCode === 0) {
        // Write analysis output file
        const analysisPath = path.join(
          opts?.refinementDir || tmpDir,
          'refinement',
          `analysis_${role}.md`,
        );
        fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
        fs.writeFileSync(analysisPath, analysisContent[role] || `# ${role} analysis`);

        // Write auto_dump
        const dumpPath = path.join(
          opts?.refinementDir || tmpDir,
          'refinement',
          `worker_${role}_c${cycle}_dump.json`,
        );
        fs.writeFileSync(dumpPath, JSON.stringify(buildAutoDump(role)));
      } else {
        child.stderr.emit('data', Buffer.from(`Error: ${role} worker failed`));
      }
      child.emit('exit', exitCode, null);
    });

    return child;
  });

  return { spawn: spawnFn, calls };
}

/**
 * Build standard deps for spawnRefinementTeam.
 */
function makeDeps(overrides = {}) {
  const forge = createMockForge(overrides);
  return {
    spawn: forge.spawn,
    prdPath: path.join(tmpDir, 'prd.md'),
    refinementDir: path.join(tmpDir, 'refinement'),
    cycles: overrides.cycles ?? undefined,
    workerTimeoutMs: overrides.workerTimeoutMs ?? 5000,
    killEscalationMs: overrides.killEscalationMs ?? 1000,
    agentDir: overrides.agentDir ?? path.join(tmpDir, '.forge', 'agents'),
    _mockForge: forge,
    ...overrides,
  };
}

/**
 * Write mock agent definition files to extract model info.
 */
function writeAgentDefs(agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'analyst-requirements.md'),
    '---\nid: analyst-requirements\ntitle: "Requirements Analyst"\nmodel: anthropic/claude-sonnet-4-6\n---\nAnalyze requirements.\n',
  );
  fs.writeFileSync(
    path.join(agentDir, 'analyst-codebase.md'),
    '---\nid: analyst-codebase\ntitle: "Codebase Analyst"\nmodel: anthropic/claude-sonnet-4-6\n---\nAnalyze codebase.\n',
  );
  fs.writeFileSync(
    path.join(agentDir, 'analyst-risk.md'),
    '---\nid: analyst-risk\ntitle: "Risk Analyst"\nmodel: anthropic/claude-haiku-4-5\n---\nAudit risks.\n',
  );
}

// ---------------------------------------------------------------------------
// AC 3.1 — parallel-spawn: Three workers spawn in parallel per cycle
// ---------------------------------------------------------------------------
describe('parallel-spawn', () => {
  it('spawns exactly three workers per cycle', async () => {
    const deps = makeDeps({ cycles: 1 });
    const result = await spawnRefinementTeam(deps);
    assert.equal(deps.spawn.mock.callCount(), 3, 'Should spawn 3 workers per cycle');
  });

  it('spawns workers for all three roles', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const spawnedRoles = deps._mockForge.calls.map(c => c.role).sort();
    assert.deepStrictEqual(spawnedRoles, ['codebase', 'requirements', 'risk-scope']);
  });

  it('spawns workers in parallel (not sequential)', async () => {
    const deps = makeDeps({ cycles: 1 });
    // All 3 should be spawned before any exits
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const origSpawn = deps.spawn;
    deps.spawn = mock.fn((...args) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      const child = origSpawn(...args);
      child.on('exit', () => { concurrentCount--; });
      return child;
    });
    await spawnRefinementTeam(deps);
    assert.equal(maxConcurrent, 3, 'All 3 workers should be concurrent');
  });

  it('spawns 6 workers for 2 cycles', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    assert.equal(deps.spawn.mock.callCount(), 6, 'Should spawn 3 workers × 2 cycles');
  });

  it('passes --agent flag with role-specific agent', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    for (const call of deps._mockForge.calls) {
      const args = call.args;
      assert(args.includes('--agent'), `Worker ${call.role} should have --agent flag`);
      const agentIdx = args.indexOf('--agent');
      const agentName = args[agentIdx + 1];
      assert(
        agentName.includes('analyst-'),
        `Agent name "${agentName}" should contain "analyst-"`,
      );
    }
  });

  it('passes -C flag with working directory', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    for (const call of deps._mockForge.calls) {
      const args = call.args;
      assert(args.includes('-C'), `Worker ${call.role} should have -C flag`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 3.2 — cross-reference: Cycle 2+ prompts include all prior analyses
// ---------------------------------------------------------------------------
describe('cross-reference', () => {
  it('cycle 1 prompt does NOT include prior analyses', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    const cycle1Calls = deps._mockForge.calls.filter(c => c.cycle === 1);
    for (const call of cycle1Calls) {
      const prompt = call.args.find(a => typeof a === 'string' && a.length > 50) || '';
      assert(
        !prompt.includes('Previous analysis') && !prompt.includes('Prior analysis'),
        `Cycle 1 ${call.role} prompt should not reference prior analyses`,
      );
    }
  });

  it('cycle 2 prompt includes cycle 1 analysis content', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    const cycle2Calls = deps._mockForge.calls.filter(c => c.cycle === 2);
    assert(cycle2Calls.length > 0, 'Should have cycle 2 calls');
    for (const call of cycle2Calls) {
      const prompt = call.args.find(a => typeof a === 'string' && a.length > 50) || '';
      // Cycle 2 should reference prior analysis content from all 3 roles
      for (const role of ROLES) {
        assert(
          prompt.includes(`analysis_${role}`) || prompt.includes(MOCK_ANALYSIS_CONTENT[role].substring(0, 30)),
          `Cycle 2 ${call.role} prompt should include ${role} analysis from cycle 1`,
        );
      }
    }
  });

  it('cycle 3 prompt includes analyses from cycles 1 and 2', async () => {
    const deps = makeDeps({ cycles: 3 });
    await spawnRefinementTeam(deps);
    const cycle3Calls = deps._mockForge.calls.filter(c => c.cycle === 3);
    assert(cycle3Calls.length > 0, 'Should have cycle 3 calls');
    for (const call of cycle3Calls) {
      const prompt = call.args.find(a => typeof a === 'string' && a.length > 50) || '';
      assert(
        prompt.length > 100,
        `Cycle 3 ${call.role} prompt should be enriched with prior analyses`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC 3.3 — cycle-count: Configurable cycle count (default 3)
// ---------------------------------------------------------------------------
describe('cycle-count', () => {
  it('defaults to 3 cycles when not specified', async () => {
    const deps = makeDeps(); // no cycles specified
    await spawnRefinementTeam(deps);
    assert.equal(deps.spawn.mock.callCount(), 9, 'Default 3 cycles × 3 workers = 9 spawns');
  });

  it('respects custom cycle count of 1', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    assert.equal(deps.spawn.mock.callCount(), 3, '1 cycle × 3 workers = 3 spawns');
  });

  it('respects custom cycle count of 5', async () => {
    const deps = makeDeps({ cycles: 5 });
    await spawnRefinementTeam(deps);
    assert.equal(deps.spawn.mock.callCount(), 15, '5 cycles × 3 workers = 15 spawns');
  });

  it('exports DEFAULT_CYCLES constant', () => {
    assert.equal(DEFAULT_CYCLES, 3, 'DEFAULT_CYCLES should be 3');
  });
});

// ---------------------------------------------------------------------------
// AC 3.4 — model-selection: Per-role model via agent definitions
// ---------------------------------------------------------------------------
describe('model-selection', () => {
  it('exports ROLE_AGENTS mapping all three roles to agent IDs', () => {
    assert(ROLE_AGENTS.requirements, 'Should map requirements role');
    assert(ROLE_AGENTS.codebase, 'Should map codebase role');
    assert(ROLE_AGENTS['risk-scope'], 'Should map risk-scope role');
  });

  it('uses analyst-requirements agent for requirements role', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const reqCall = deps._mockForge.calls.find(c => c.role === 'requirements');
    const agentIdx = reqCall.args.indexOf('--agent');
    assert.equal(reqCall.args[agentIdx + 1], 'analyst-requirements');
  });

  it('uses analyst-codebase agent for codebase role', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const cbCall = deps._mockForge.calls.find(c => c.role === 'codebase');
    const agentIdx = cbCall.args.indexOf('--agent');
    assert.equal(cbCall.args[agentIdx + 1], 'analyst-codebase');
  });

  it('uses analyst-risk agent for risk-scope role', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const riskCall = deps._mockForge.calls.find(c => c.role === 'risk-scope');
    const agentIdx = riskCall.args.indexOf('--agent');
    assert.equal(riskCall.args[agentIdx + 1], 'analyst-risk-scope');
  });

  it('reads model from agent definition files when agentDir provided', async () => {
    const agentDir = path.join(tmpDir, '.forge', 'agents');
    writeAgentDefs(agentDir);
    const deps = makeDeps({ cycles: 1, agentDir });
    const result = await spawnRefinementTeam(deps);
    // Manifest should record which model was used per role
    assert(result.workers, 'Result should have workers');
    const reqWorker = result.workers.find(w => w.role === 'requirements');
    assert(reqWorker.model || reqWorker.agent, 'Worker should record model or agent used');
  });
});

// ---------------------------------------------------------------------------
// AC 3.5 — token-detection: ANALYSIS_DONE token detected per worker
// ---------------------------------------------------------------------------
describe('token-detection', () => {
  it('detects ANALYSIS_DONE token in worker auto_dump', async () => {
    const deps = makeDeps({ cycles: 1 });
    const result = await spawnRefinementTeam(deps);
    for (const worker of result.workers) {
      assert.equal(worker.success, true, `Worker ${worker.role} should succeed when ANALYSIS_DONE found`);
    }
  });

  it('marks worker as failed when ANALYSIS_DONE token missing', async () => {
    const forge = createMockForge();
    // Override to not write auto_dump with token
    const origSpawn = forge.spawn;
    const noTokenSpawn = mock.fn((...args) => {
      const child = origSpawn(...args);
      // Remove the token from auto_dump after write
      child.on('exit', () => {
        const dumpFiles = fs.readdirSync(path.join(tmpDir, 'refinement'))
          .filter(f => f.endsWith('_dump.json'));
        for (const df of dumpFiles) {
          const dumpPath = path.join(tmpDir, 'refinement', df);
          if (fs.existsSync(dumpPath)) {
            const content = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
            const msgs = content.conversation.context.messages;
            for (const msg of msgs) {
              if (msg.text?.content) {
                msg.text.content = msg.text.content.replace(/<promise>ANALYSIS_DONE<\/promise>/g, '');
              }
            }
            fs.writeFileSync(dumpPath, JSON.stringify(content));
          }
        }
      });
      return child;
    });
    const deps = makeDeps({ cycles: 1, spawn: noTokenSpawn });
    const result = await spawnRefinementTeam(deps);
    const failedWorkers = result.workers.filter(w => !w.success);
    assert(failedWorkers.length > 0, 'Workers without ANALYSIS_DONE should be marked failed');
  });

  it('parses ANALYSIS_DONE from auto_dump conversation JSON', async () => {
    const deps = makeDeps({ cycles: 1 });
    const result = await spawnRefinementTeam(deps);
    // All workers should have token detected
    assert.equal(result.all_success, true, 'All workers should succeed with ANALYSIS_DONE');
  });
});

// ---------------------------------------------------------------------------
// AC 3.6 — failure-handling: requirements halts, risk warns+continues
// ---------------------------------------------------------------------------
describe('failure-handling', () => {
  it('requirements analyst failure halts remaining cycles', async () => {
    const deps = makeDeps({ cycles: 3, failRole: 'requirements' });
    const result = await spawnRefinementTeam(deps);
    assert.equal(result.all_success, false, 'Overall result should be failure');
    assert.equal(
      result.cycles_completed, 1,
      'Should halt after first cycle when requirements fails',
    );
    // Only cycle 1 workers should have been spawned (3 workers)
    assert.equal(deps.spawn.mock.callCount(), 3, 'Should not spawn cycle 2 workers');
  });

  it('codebase analyst failure halts remaining cycles', async () => {
    const deps = makeDeps({ cycles: 3, failRole: 'codebase' });
    const result = await spawnRefinementTeam(deps);
    assert.equal(result.all_success, false);
    assert.equal(
      result.cycles_completed, 1,
      'Codebase failure should halt like requirements',
    );
  });

  it('risk-scope analyst failure warns but continues', async () => {
    const deps = makeDeps({ cycles: 2, failRole: 'risk-scope' });
    const result = await spawnRefinementTeam(deps);
    // Risk failure should not halt — remaining cycles continue
    assert.equal(
      result.cycles_completed, 2,
      'Risk-scope failure should not halt remaining cycles',
    );
    const riskWorker = result.workers.find(w => w.role === 'risk-scope');
    assert.equal(riskWorker.success, false, 'Risk worker should be marked as failed');
  });

  it('risk-scope failure is recorded as warning in manifest', async () => {
    const deps = makeDeps({ cycles: 1, failRole: 'risk-scope' });
    const result = await spawnRefinementTeam(deps);
    const riskWorker = result.workers.find(w => w.role === 'risk-scope');
    assert.equal(riskWorker.success, false);
    // Overall should still be true if only risk failed
    assert.equal(
      result.all_success, true,
      'all_success should be true when only risk-scope fails (warning-level)',
    );
  });
});

// ---------------------------------------------------------------------------
// AC 3.7 — manifest: refinement_manifest.json with per-worker results
// ---------------------------------------------------------------------------
describe('manifest', () => {
  it('writes refinement_manifest.json to refinement dir', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifestPath = path.join(tmpDir, 'refinement', 'refinement_manifest.json');
    assert(fs.existsSync(manifestPath), 'Manifest file should exist');
  });

  it('manifest contains prd_path', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    assert.equal(manifest.prd_path, deps.prdPath);
  });

  it('manifest contains cycles_requested and cycles_completed', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    assert.equal(manifest.cycles_requested, 2);
    assert.equal(manifest.cycles_completed, 2);
  });

  it('manifest workers array has entry per role', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    assert.equal(manifest.workers.length, 3);
    const roles = manifest.workers.map(w => w.role).sort();
    assert.deepStrictEqual(roles, ['codebase', 'requirements', 'risk-scope']);
  });

  it('each worker entry has success, output_file, log_file, cycle fields', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    for (const worker of manifest.workers) {
      assert(typeof worker.success === 'boolean', `${worker.role} missing success field`);
      assert(typeof worker.output_file === 'string', `${worker.role} missing output_file`);
      assert(typeof worker.log_file === 'string', `${worker.role} missing log_file`);
      assert(typeof worker.cycle === 'number', `${worker.role} missing cycle`);
    }
  });

  it('manifest has completed_at timestamp', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    assert(manifest.completed_at, 'Should have completed_at');
    assert(!isNaN(Date.parse(manifest.completed_at)), 'completed_at should be valid ISO date');
  });

  it('manifest workers contain findings_summary with p0, p1, p2 counts', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    for (const worker of manifest.workers) {
      assert(worker.findings_summary, `${worker.role} should have findings_summary`);
      assert(typeof worker.findings_summary.p0 === 'number', `${worker.role} findings_summary.p0 should be number`);
      assert(typeof worker.findings_summary.p1 === 'number', `${worker.role} findings_summary.p1 should be number`);
      assert(typeof worker.findings_summary.p2 === 'number', `${worker.role} findings_summary.p2 should be number`);
    }
  });

  it('findings_summary counts match actual analysis content', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    // MOCK_ANALYSIS_CONTENT.requirements has 1 P0, 1 P1
    const reqWorker = manifest.workers.find(w => w.role === 'requirements');
    assert.equal(reqWorker.findings_summary.p0, 1, 'Requirements should have 1 P0');
    assert.equal(reqWorker.findings_summary.p1, 1, 'Requirements should have 1 P1');
    // MOCK_ANALYSIS_CONTENT.codebase has 1 P0, 1 P1
    const cbWorker = manifest.workers.find(w => w.role === 'codebase');
    assert.equal(cbWorker.findings_summary.p0, 1, 'Codebase should have 1 P0');
    assert.equal(cbWorker.findings_summary.p1, 1, 'Codebase should have 1 P1');
    // MOCK_ANALYSIS_CONTENT['risk-scope'] has 0 P0, 1 P1
    const riskWorker = manifest.workers.find(w => w.role === 'risk-scope');
    assert.equal(riskWorker.findings_summary.p0, 0, 'Risk should have 0 P0');
    assert.equal(riskWorker.findings_summary.p1, 1, 'Risk should have 1 P1');
  });

  it('manifest all_success reflects worker outcomes', async () => {
    const deps = makeDeps({ cycles: 1 });
    await spawnRefinementTeam(deps);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'refinement', 'refinement_manifest.json'), 'utf-8'),
    );
    assert.equal(manifest.all_success, true, 'all_success true when all workers succeed');
  });
});

// ---------------------------------------------------------------------------
// AC 3.8 — archive: Per-cycle archives preserved
// ---------------------------------------------------------------------------
describe('archive', () => {
  it('creates analysis_*_c1.md archive files after cycle 1', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    for (const role of ROLES) {
      const archivePath = path.join(tmpDir, 'refinement', `analysis_${role}_c1.md`);
      assert(
        fs.existsSync(archivePath),
        `Archive file ${archivePath} should exist for ${role} cycle 1`,
      );
    }
  });

  it('creates analysis_*_c2.md archive files after cycle 2', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    for (const role of ROLES) {
      const archivePath = path.join(tmpDir, 'refinement', `analysis_${role}_c2.md`);
      assert(
        fs.existsSync(archivePath),
        `Archive file ${archivePath} should exist for ${role} cycle 2`,
      );
    }
  });

  it('current analysis files (no cycle suffix) contain latest cycle content', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    for (const role of ROLES) {
      const currentPath = path.join(tmpDir, 'refinement', `analysis_${role}.md`);
      assert(
        fs.existsSync(currentPath),
        `Current analysis file should exist for ${role}`,
      );
    }
  });

  it('archive files are distinct copies, not symlinks', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    for (const role of ROLES) {
      const c1Path = path.join(tmpDir, 'refinement', `analysis_${role}_c1.md`);
      const stat = fs.lstatSync(c1Path);
      assert(!stat.isSymbolicLink(), `${c1Path} should not be a symlink`);
    }
  });

  it('worker log files preserved per cycle', async () => {
    const deps = makeDeps({ cycles: 2 });
    await spawnRefinementTeam(deps);
    for (const role of ROLES) {
      for (const cycle of [1, 2]) {
        const logPath = path.join(tmpDir, 'refinement', `worker_${role}_c${cycle}.log`);
        assert(
          fs.existsSync(logPath),
          `Worker log ${logPath} should exist`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC 3.9 — early-exit: zero P0/P1 findings → skip remaining cycles
// ---------------------------------------------------------------------------
describe('early-exit', () => {
  it('skips remaining cycles when all analyses have zero P0/P1 findings', async () => {
    const forge = createMockForge({ analysisContent: MOCK_ANALYSIS_NO_FINDINGS });
    const deps = makeDeps({ cycles: 3, spawn: forge.spawn, _mockForge: forge });
    const result = await spawnRefinementTeam(deps);
    // With no P0/P1 findings in cycle 1, should skip cycles 2 and 3
    assert(
      result.cycles_completed < 3,
      `Should skip remaining cycles, but completed ${result.cycles_completed}`,
    );
    assert.equal(
      result.cycles_completed, 1,
      'Should exit after first cycle with zero findings',
    );
  });

  it('continues cycles when P0 findings exist', async () => {
    const deps = makeDeps({ cycles: 3 });
    const result = await spawnRefinementTeam(deps);
    // MOCK_ANALYSIS_CONTENT has P0 findings, so all 3 cycles should run
    assert.equal(
      result.cycles_completed, 3,
      'Should complete all cycles when P0 findings exist',
    );
  });

  it('continues cycles when P1 findings exist (no P0)', async () => {
    const analysisP1Only = {
      requirements: '# Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n- [P1] Missing validation\n',
      codebase: '# Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n- [P1] Code smell\n',
      'risk-scope': '# Analysis\n\n## Critical Gaps (P0)\n\n## Important Gaps (P1)\n\n',
    };
    const forge = createMockForge({ analysisContent: analysisP1Only });
    const deps = makeDeps({ cycles: 3, spawn: forge.spawn, _mockForge: forge });
    const result = await spawnRefinementTeam(deps);
    assert.equal(
      result.cycles_completed, 3,
      'Should complete all cycles when P1 findings exist',
    );
  });

  it('manifest records early_exit reason', async () => {
    const forge = createMockForge({ analysisContent: MOCK_ANALYSIS_NO_FINDINGS });
    const deps = makeDeps({ cycles: 3, spawn: forge.spawn, _mockForge: forge });
    const result = await spawnRefinementTeam(deps);
    assert(
      result.early_exit || result.exit_reason,
      'Result should indicate early exit reason',
    );
  });
});

// ---------------------------------------------------------------------------
// AC 3.10 — worker-timeout: per-worker timeout with SIGTERM/SIGKILL escalation
// ---------------------------------------------------------------------------
describe('worker-timeout', () => {
  it('sends SIGTERM to hanging worker after timeout', async () => {
    const forge = createMockForge({ hangRole: 'codebase' });
    const deps = makeDeps({
      cycles: 1,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    await spawnRefinementTeam(deps);
    const hangingCall = forge.calls.find(c => c.role === 'codebase');
    const signals = hangingCall.child.kill.mock.calls.map(c => c.arguments[0]);
    assert(signals.includes('SIGTERM'), 'Should send SIGTERM first');
  });

  it('escalates to SIGKILL after kill escalation delay', async () => {
    const forge = createMockForge({ hangRole: 'codebase' });
    const deps = makeDeps({
      cycles: 1,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    await spawnRefinementTeam(deps);
    const hangingCall = forge.calls.find(c => c.role === 'codebase');
    const signals = hangingCall.child.kill.mock.calls.map(c => c.arguments[0]);
    assert(signals.includes('SIGKILL'), 'Should escalate to SIGKILL');
  });

  it('marks timed-out worker as failed in manifest', async () => {
    const forge = createMockForge({ hangRole: 'requirements' });
    const deps = makeDeps({
      cycles: 1,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    const result = await spawnRefinementTeam(deps);
    const reqWorker = result.workers.find(w => w.role === 'requirements');
    assert.equal(reqWorker.success, false, 'Timed-out worker should be marked failed');
  });

  it('timeout on requirements halts like other requirements failures', async () => {
    const forge = createMockForge({ hangRole: 'requirements' });
    const deps = makeDeps({
      cycles: 3,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    const result = await spawnRefinementTeam(deps);
    assert.equal(result.cycles_completed, 1, 'Requirements timeout should halt remaining cycles');
  });

  it('timeout on risk-scope warns but continues', async () => {
    const forge = createMockForge({ hangRole: 'risk-scope' });
    const deps = makeDeps({
      cycles: 2,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    const result = await spawnRefinementTeam(deps);
    assert.equal(result.cycles_completed, 2, 'Risk-scope timeout should not halt');
  });

  it('non-hanging workers complete normally alongside timed-out worker', async () => {
    const forge = createMockForge({ hangRole: 'risk-scope' });
    const deps = makeDeps({
      cycles: 1,
      spawn: forge.spawn,
      _mockForge: forge,
      workerTimeoutMs: 50,
      killEscalationMs: 30,
    });
    const result = await spawnRefinementTeam(deps);
    const reqWorker = result.workers.find(w => w.role === 'requirements');
    const cbWorker = result.workers.find(w => w.role === 'codebase');
    assert.equal(reqWorker.success, true, 'Requirements should succeed');
    assert.equal(cbWorker.success, true, 'Codebase should succeed');
  });
});

// ---------------------------------------------------------------------------
// Integration — WORKER_ROLES export
// ---------------------------------------------------------------------------
describe('WORKER_ROLES export', () => {
  it('exports all three role identifiers', () => {
    assert(Array.isArray(WORKER_ROLES), 'WORKER_ROLES should be an array');
    assert.equal(WORKER_ROLES.length, 3);
    assert(WORKER_ROLES.includes('requirements'));
    assert(WORKER_ROLES.includes('codebase'));
    assert(WORKER_ROLES.includes('risk-scope'));
  });
});
