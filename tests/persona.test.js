import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORGE = path.join(ROOT, '.forge');
const AGENTS_DIR = path.join(FORGE, 'agents');
const AGENTS_MD = path.join(FORGE, 'AGENTS.md');

/** Parse YAML frontmatter from a .md file. Returns {meta, body}. */
function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: null, body: raw };
  const lines = match[1].split('\n');
  const meta = {};
  for (const line of lines) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // Parse arrays like [read, write, patch]
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    // Parse numbers
    if (/^\d+$/.test(val)) val = Number(val);
    // Strip quotes
    if (typeof val === 'string') val = val.replace(/^["']|["']$/g, '');
    meta[kv[1]] = val;
  }
  return { meta, body: match[2] };
}

const AGENT_FILES = [
  'pickle-manager.md',
  'morty-worker.md',
  'microverse-worker.md',
  'microverse-judge.md',
  'microverse-analyst.md',
  'anatomy-tracer.md',
  'anatomy-surgeon.md',
  'anatomy-verifier.md',
  'szechuan-reviewer.md',
];

const REQUIRED_FRONTMATTER = ['id', 'title', 'model', 'tools', 'max_requests_per_turn'];

const JUDGE_AGENTS = ['microverse-judge'];

const PERSONA_KEYWORDS = /rick|pickle|persona|belch/i;

// ---------------------------------------------------------------------------
// AGENTS.md — persona definition
// ---------------------------------------------------------------------------
describe('AGENTS.md', () => {
  it('exists', () => {
    assert.ok(fs.existsSync(AGENTS_MD), '.forge/AGENTS.md must exist');
  });

  it('contains Pickle Rick persona', () => {
    const content = fs.readFileSync(AGENTS_MD, 'utf-8');
    assert.ok(content.includes('Pickle Rick'), 'must contain "Pickle Rick"');
  });

  it('has all 5 routing rules', () => {
    const content = fs.readFileSync(AGENTS_MD, 'utf-8');
    const rules = [
      /multi-file.*PRD/i,
      /prd\.md.*refine/i,
      /one-liner.*just do it/i,
      /question.*answer/i,
      /meta.*dispatch/i,
    ];
    for (const rule of rules) {
      assert.ok(rule.test(content), `missing routing rule: ${rule}`);
    }
  });

  it('has drop-persona opt-out', () => {
    const content = fs.readFileSync(AGENTS_MD, 'utf-8');
    assert.ok(/drop persona/i.test(content), 'must contain "drop persona" opt-out');
  });

  it('has text-before-tool-call rule', () => {
    const content = fs.readFileSync(AGENTS_MD, 'utf-8');
    assert.ok(/text before.*tool call/i.test(content), 'must have text-before-tool-call rule');
  });
});

// ---------------------------------------------------------------------------
// Agent files — existence and frontmatter
// ---------------------------------------------------------------------------
describe('agent files', () => {
  for (const file of AGENT_FILES) {
    describe(file, () => {
      const filePath = path.join(AGENTS_DIR, file);

      it('exists', () => {
        assert.ok(fs.existsSync(filePath), `${file} must exist`);
      });

      it('has valid YAML frontmatter with required fields', () => {
        const { meta } = parseFrontmatter(filePath);
        assert.ok(meta, `${file} must have YAML frontmatter`);
        for (const field of REQUIRED_FRONTMATTER) {
          assert.ok(
            meta[field] !== undefined && meta[field] !== null,
            `${file} missing frontmatter field: ${field}`
          );
        }
      });

      it('has tools as an array', () => {
        const { meta } = parseFrontmatter(filePath);
        assert.ok(Array.isArray(meta.tools), `${file} tools must be an array`);
        assert.ok(meta.tools.length > 0, `${file} tools must not be empty`);
      });

      it('max_requests_per_turn is a positive number', () => {
        const { meta } = parseFrontmatter(filePath);
        assert.ok(typeof meta.max_requests_per_turn === 'number', `${file} max_requests_per_turn must be a number`);
        assert.ok(meta.max_requests_per_turn > 0, `${file} max_requests_per_turn must be positive`);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Persona injection — non-judge agents have persona keywords
// ---------------------------------------------------------------------------
describe('persona-injection', () => {
  const nonJudgeFiles = AGENT_FILES.filter(f => !JUDGE_AGENTS.includes(f.replace('.md', '')));

  for (const file of nonJudgeFiles) {
    it(`${file} has persona keywords`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8');
      assert.ok(PERSONA_KEYWORDS.test(content), `${file} must have persona keywords (Rick/Pickle/persona/belch)`);
    });
  }
});

// ---------------------------------------------------------------------------
// Judge agents — NO persona keywords
// ---------------------------------------------------------------------------
describe('judge-no-persona', () => {
  for (const agentId of JUDGE_AGENTS) {
    it(`${agentId}.md has NO persona keywords`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentId}.md`), 'utf-8');
      assert.ok(!PERSONA_KEYWORDS.test(content), `${agentId}.md must NOT have persona keywords`);
    });
  }
});

// ---------------------------------------------------------------------------
// Text before tool call — all agents
// ---------------------------------------------------------------------------
describe('text-before-tool', () => {
  for (const file of AGENT_FILES) {
    it(`${file} has text-before-tool-call rule`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8');
      assert.ok(/text before.*tool call/i.test(content), `${file} must have "text before tool call" rule`);
    });
  }
});
