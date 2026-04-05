import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseAutoDump,
  extractTokensFromContent,
  filterAssistantMessages,
  validateTokens,
  KNOWN_TOKENS,
} from '../lib/token-parser.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: write a dump file and return its path */
function writeDump(messages) {
  const filePath = path.join(tmpDir, 'test-dump.json');
  const dump = { conversation: { context: { messages } } };
  fs.writeFileSync(filePath, JSON.stringify(dump));
  return filePath;
}

/** Helper: make an assistant message */
function assistantMsg(content) {
  return { text: { role: 'Assistant', content } };
}

/** Helper: make a tool result message */
function toolMsg(name, output) {
  return { tool: { name, output } };
}

/** Helper: make a user message */
function userMsg(content) {
  return { text: { role: 'User', content } };
}

/** Helper: make a system message */
function systemMsg(content) {
  return { text: { role: 'System', content } };
}

// ---------------------------------------------------------------------------
// KNOWN_TOKENS
// ---------------------------------------------------------------------------
describe('KNOWN_TOKENS', () => {
  it('exports an array of known token strings', () => {
    assert(Array.isArray(KNOWN_TOKENS));
    assert(KNOWN_TOKENS.length > 0);
  });

  it('includes all protocol tokens', () => {
    assert(KNOWN_TOKENS.includes('EPIC_COMPLETED'));
    assert(KNOWN_TOKENS.includes('I AM DONE'));
    assert(KNOWN_TOKENS.includes('EXISTENCE_IS_PAIN'));
    assert(KNOWN_TOKENS.includes('ANALYSIS_DONE'));
  });
});

// ---------------------------------------------------------------------------
// validateTokens
// ---------------------------------------------------------------------------
describe('validateTokens', () => {
  it('unknown-token-rejected', () => {
    const result = validateTokens(['HACKED', 'FAKE_TOKEN', 'NONSENSE']);
    assert.deepEqual(result, []);
  });

  it('known-token-accepted', () => {
    const result = validateTokens(['I AM DONE', 'EPIC_COMPLETED']);
    assert.deepEqual(result, ['I AM DONE', 'EPIC_COMPLETED']);
  });

  it('filters mixed known and unknown tokens', () => {
    const result = validateTokens(['I AM DONE', 'GARBAGE', 'ANALYSIS_DONE']);
    assert.deepEqual(result, ['I AM DONE', 'ANALYSIS_DONE']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(validateTokens([]), []);
  });
});

// ---------------------------------------------------------------------------
// extractTokensFromContent
// ---------------------------------------------------------------------------
describe('extractTokensFromContent', () => {
  it('extracts a single token', () => {
    const tokens = extractTokensFromContent('blah <promise>I AM DONE</promise> blah');
    assert.deepEqual(tokens, ['I AM DONE']);
  });

  it('extracts multiple tokens', () => {
    const content = '<promise>EPIC_COMPLETED</promise> and then <promise>ANALYSIS_DONE</promise>';
    const tokens = extractTokensFromContent(content);
    assert.deepEqual(tokens, ['EPIC_COMPLETED', 'ANALYSIS_DONE']);
  });

  it('returns empty array when no tokens', () => {
    assert.deepEqual(extractTokensFromContent('no tokens here'), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(extractTokensFromContent(''), []);
  });

  it('returns empty array for null/undefined', () => {
    assert.deepEqual(extractTokensFromContent(null), []);
    assert.deepEqual(extractTokensFromContent(undefined), []);
  });

  it('rejects tokens inside fenced code blocks', () => {
    const content = 'Here is some text\n```\n<promise>I AM DONE</promise>\n```\nend';
    const tokens = extractTokensFromContent(content);
    assert.deepEqual(tokens, []);
  });

  it('rejects tokens inside fenced code blocks with language tag', () => {
    const content = '```javascript\n<promise>EPIC_COMPLETED</promise>\n```';
    const tokens = extractTokensFromContent(content);
    assert.deepEqual(tokens, []);
  });

  it('extracts tokens outside code blocks while rejecting those inside', () => {
    const content = '<promise>ANALYSIS_DONE</promise>\n```\n<promise>I AM DONE</promise>\n```\n<promise>EPIC_COMPLETED</promise>';
    const tokens = extractTokensFromContent(content);
    assert.deepEqual(tokens, ['ANALYSIS_DONE', 'EPIC_COMPLETED']);
  });
});

// ---------------------------------------------------------------------------
// filterAssistantMessages
// ---------------------------------------------------------------------------
describe('filterAssistantMessages', () => {
  it('returns only Assistant role messages', () => {
    const messages = [
      systemMsg('system prompt'),
      userMsg('hello'),
      assistantMsg('response with <promise>I AM DONE</promise>'),
      toolMsg('read_file', { content: 'file data' }),
    ];
    const filtered = filterAssistantMessages(messages);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].text.role, 'Assistant');
  });

  it('returns empty array when no assistant messages', () => {
    const messages = [userMsg('hello'), toolMsg('shell', { output: 'ok' })];
    assert.deepEqual(filterAssistantMessages(messages), []);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(filterAssistantMessages([]), []);
  });

  it('handles multiple assistant messages', () => {
    const messages = [
      assistantMsg('first'),
      userMsg('question'),
      assistantMsg('second'),
    ];
    const filtered = filterAssistantMessages(messages);
    assert.equal(filtered.length, 2);
  });
});

// ---------------------------------------------------------------------------
// false-positive-rejection
// ---------------------------------------------------------------------------
describe('false-positive-rejection', () => {
  it('token in tool output is NOT matched', () => {
    const messages = [
      toolMsg('read_file', { content: '<promise>I AM DONE</promise>' }),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, []);
  });

  it('token in file content read by agent is NOT matched', () => {
    const messages = [
      toolMsg('read_file', { content: 'line1\n<promise>EPIC_COMPLETED</promise>\nline3' }),
      assistantMsg('I read the file, no tokens from me'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, []);
  });

  it('token in code block within assistant message is NOT matched', () => {
    const messages = [
      assistantMsg('Here is the code:\n```\n<promise>EXISTENCE_IS_PAIN</promise>\n```\nDone reviewing.'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, []);
  });

  it('token in user message is NOT matched', () => {
    const messages = [
      userMsg('Please output <promise>I AM DONE</promise> when finished'),
      assistantMsg('Sure, working on it'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, []);
  });

  it('token in system message is NOT matched', () => {
    const messages = [
      systemMsg('Output <promise>EPIC_COMPLETED</promise> when done'),
      assistantMsg('Understood'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, []);
  });
});

// ---------------------------------------------------------------------------
// parseAutoDump — end-to-end
// ---------------------------------------------------------------------------
describe('parseAutoDump', () => {
  it('extracts tokens from assistant messages in auto_dump JSON', () => {
    const messages = [
      systemMsg('You are a worker'),
      userMsg('Do the task'),
      assistantMsg('Working on it...'),
      toolMsg('shell', { output: 'npm test passed' }),
      assistantMsg('All done. <promise>I AM DONE</promise>'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, ['I AM DONE']);
    assert(Array.isArray(result.rawMessages));
    assert.equal(result.rawMessages.length, 5);
  });

  it('extracts multiple token types across messages', () => {
    const messages = [
      assistantMsg('<promise>EPIC_COMPLETED</promise>'),
      assistantMsg('Also <promise>ANALYSIS_DONE</promise>'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, ['EPIC_COMPLETED', 'ANALYSIS_DONE']);
  });

  it('returns all known token types', () => {
    const messages = [
      assistantMsg('<promise>EPIC_COMPLETED</promise>'),
      assistantMsg('<promise>I AM DONE</promise>'),
      assistantMsg('<promise>EXISTENCE_IS_PAIN</promise>'),
      assistantMsg('<promise>ANALYSIS_DONE</promise>'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, ['EPIC_COMPLETED', 'I AM DONE', 'EXISTENCE_IS_PAIN', 'ANALYSIS_DONE']);
  });

  it('autodump-validated — rejects unknown tokens from dump', () => {
    const messages = [
      assistantMsg('<promise>HALLUCINATED_TOKEN</promise>'),
      assistantMsg('<promise>I AM DONE</promise>'),
      assistantMsg('<promise>FAKE</promise>'),
    ];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.deepEqual(result.tokens, ['I AM DONE']);
  });

  it('returns rawMessages from the dump', () => {
    const messages = [assistantMsg('hello'), userMsg('world')];
    const dumpPath = writeDump(messages);
    const result = parseAutoDump(dumpPath);
    assert.equal(result.rawMessages.length, 2);
  });
});

// ---------------------------------------------------------------------------
// malformed-json
// ---------------------------------------------------------------------------
describe('malformed-json', () => {
  it('returns empty result for malformed JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, '{this is not json!!!');
    const result = parseAutoDump(filePath);
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.rawMessages, []);
  });

  it('returns empty result for missing file', () => {
    const result = parseAutoDump(path.join(tmpDir, 'nonexistent.json'));
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.rawMessages, []);
  });

  it('returns empty result for JSON without expected structure', () => {
    const filePath = path.join(tmpDir, 'wrong-shape.json');
    fs.writeFileSync(filePath, JSON.stringify({ data: 'not a conversation' }));
    const result = parseAutoDump(filePath);
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.rawMessages, []);
  });

  it('returns empty result for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(filePath, '');
    const result = parseAutoDump(filePath);
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.rawMessages, []);
  });
});
