/**
 * TokenParser — Extract promise tokens from ForgeCode auto_dump JSON.
 *
 * Scans only Assistant-role messages. Tool results, user messages,
 * system messages, and code blocks are structurally excluded.
 * ESM module, zero dependencies.
 */
import fs from 'node:fs';

export const KNOWN_TOKENS = [
  'EPIC_COMPLETED',
  'I AM DONE',
  'EXISTENCE_IS_PAIN',
  'ANALYSIS_DONE',
];

const TOKEN_RE = /<promise>(.*?)<\/promise>/g;
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;

/**
 * Extract promise tokens from a content string.
 * Strips fenced code blocks first to prevent false positives.
 */
export function extractTokensFromContent(content) {
  if (content == null) return [];
  const cleaned = String(content).replace(FENCED_BLOCK_RE, '');
  return [...cleaned.matchAll(TOKEN_RE)].map(m => m[1]);
}

/**
 * Filter tokens to only those in KNOWN_TOKENS.
 */
export function validateTokens(tokens) {
  return tokens.filter(t => KNOWN_TOKENS.includes(t));
}

/**
 * Filter messages array to only Assistant-role entries.
 * Assistant messages have shape: { text: { role: "Assistant", content: "..." } }
 * Tool results have shape: { tool: { ... } } — no text key.
 */
export function filterAssistantMessages(messages) {
  return messages.filter(m => m.text?.role === 'Assistant');
}

/**
 * Parse an auto_dump JSON file and extract promise tokens from assistant messages.
 * Returns { tokens: string[], rawMessages: object[] }.
 * Gracefully handles missing files, malformed JSON, and unexpected structure.
 */
export function parseAutoDump(dumpFilePath) {
  const empty = { tokens: [], rawMessages: [] };
  let raw;
  try {
    raw = fs.readFileSync(dumpFilePath, 'utf-8');
  } catch {
    return empty;
  }

  let dump;
  try {
    dump = JSON.parse(raw);
  } catch {
    return empty;
  }

  const messages = dump?.conversation?.context?.messages;
  if (!Array.isArray(messages)) return empty;

  const assistantMsgs = filterAssistantMessages(messages);
  const rawTokens = assistantMsgs.flatMap(m => extractTokensFromContent(m.text?.content));
  const tokens = validateTokens(rawTokens);

  return { tokens, rawMessages: messages };
}
