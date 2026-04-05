/**
 * CircuitBreaker — 3-state FSM for detecting stuck orchestrator loops.
 *
 * States: CLOSED (normal) -> HALF_OPEN (warning) -> OPEN (blocked).
 * ESM module, depends on StateManager for atomic persistence.
 */
import { StateManager, StateError } from './state-manager.js';

export const DEFAULT_CONFIG = {
  enabled: true,
  noProgressThreshold: 5,
  sameErrorThreshold: 5,
  halfOpenAfter: 2,
};

const STATES = { CLOSED: 'CLOSED', HALF_OPEN: 'HALF_OPEN', OPEN: 'OPEN' };

function defaultState() {
  return {
    schema_version: 1,
    state: STATES.CLOSED,
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: '',
    last_known_step: null,
    last_known_ticket: null,
    last_progress_iteration: 0,
    total_opens: 0,
    history: [],
  };
}

/**
 * Normalize error message for deduplication.
 * Paths -> <PATH>, timestamps -> <TS>, truncated to 200 chars.
 */
export function normalizeErrorSignature(msg) {
  if (msg == null) return null;
  let s = String(msg);
  // Absolute paths
  s = s.replace(/\/[\w\-./]+/g, '<PATH>');
  // ISO timestamps (2026-04-05T14:30:00.000Z or similar)
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<TS>');
  // Date-only (2026-04-05)
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, '<TS>');
  // Unix epoch milliseconds (10+ digits followed by optional ms suffix)
  s = s.replace(/\b\d{10,13}(ms)?\b/g, '<TS>');
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function validateConfig(config) {
  if (config.noProgressThreshold < 2) {
    throw new Error(`noProgressThreshold must be >= 2, got ${config.noProgressThreshold}`);
  }
  if (config.sameErrorThreshold < 2) {
    throw new Error(`sameErrorThreshold must be >= 2, got ${config.sameErrorThreshold}`);
  }
  if (config.halfOpenAfter < 1) {
    throw new Error(`halfOpenAfter must be >= 1, got ${config.halfOpenAfter}`);
  }
  if (config.halfOpenAfter >= config.noProgressThreshold) {
    throw new Error(`halfOpenAfter (${config.halfOpenAfter}) must be < noProgressThreshold (${config.noProgressThreshold})`);
  }
}

export class CircuitBreaker {
  constructor(stateFilePath, configOverrides = {}, stateManager = null) {
    this._stateFilePath = stateFilePath;
    this._sm = stateManager || new StateManager();
    this.config = { ...DEFAULT_CONFIG, ...configOverrides };
    validateConfig(this.config);
    this._state = this._loadState();
  }

  _loadState() {
    try {
      return this._sm.read(this._stateFilePath);
    } catch (err) {
      // MISSING or CORRUPT -> fail-open (default CLOSED state)
      if (err instanceof StateError && (err.code === 'MISSING' || err.code === 'CORRUPT')) {
        return defaultState();
      }
      throw err;
    }
  }

  _saveState() {
    try {
      this._sm.update(this._stateFilePath, (persisted) => {
        Object.assign(persisted, this._state);
      });
    } catch (err) {
      if (err instanceof StateError && err.code === 'MISSING') {
        // File doesn't exist yet — forceWrite to create it
        this._sm.forceWrite(this._stateFilePath, this._state);
        return;
      }
      throw err;
    }
  }

  _detectProgress(signals) {
    const s = this._state;
    return (
      signals.hasUncommittedChanges ||
      signals.hasStagedChanges ||
      (s.last_known_head !== '' && signals.headSha !== s.last_known_head) ||
      (s.last_known_step !== null && signals.step !== s.last_known_step) ||
      (s.last_known_ticket !== null && signals.ticket !== s.last_known_ticket)
    );
  }

  _addHistory(from, to, iteration) {
    this._state.history.push({
      from,
      to,
      timestamp: Date.now(),
      iteration,
    });
    if (this._state.history.length > 1000) {
      this._state.history = this._state.history.slice(-1000);
    }
  }

  recordIteration(signals) {
    const s = this._state;
    const progress = this._detectProgress(signals);

    // Update tracked signals
    s.last_known_head = signals.headSha;
    s.last_known_step = signals.step;
    s.last_known_ticket = signals.ticket;

    // Error tracking
    const normalizedError = normalizeErrorSignature(signals.error);
    if (normalizedError !== null) {
      if (normalizedError === s.last_error_signature) {
        s.consecutive_same_error++;
      } else {
        s.consecutive_same_error = 1;
        s.last_error_signature = normalizedError;
      }
    } else {
      s.consecutive_same_error = 0;
      s.last_error_signature = null;
    }

    // Progress tracking
    if (progress) {
      s.consecutive_no_progress = 0;
      s.last_progress_iteration++;
    } else {
      s.consecutive_no_progress++;
    }

    // FSM transitions
    if (s.state === STATES.CLOSED) {
      if (!progress && s.consecutive_no_progress >= this.config.halfOpenAfter) {
        s.state = STATES.HALF_OPEN;
        this._addHistory(STATES.CLOSED, STATES.HALF_OPEN, s.consecutive_no_progress);
      }
    } else if (s.state === STATES.HALF_OPEN) {
      if (progress) {
        s.state = STATES.CLOSED;
        this._addHistory(STATES.HALF_OPEN, STATES.CLOSED, s.consecutive_no_progress);
      } else if (
        s.consecutive_no_progress >= this.config.noProgressThreshold ||
        s.consecutive_same_error >= this.config.sameErrorThreshold
      ) {
        s.state = STATES.OPEN;
        s.total_opens++;
        this._addHistory(STATES.HALF_OPEN, STATES.OPEN, s.consecutive_no_progress);
      }
    }
    // OPEN state: no transitions from recordIteration (use reset())

    this._saveState();
  }

  canExecute() {
    if (!this.config.enabled) return true;
    return this._state.state !== STATES.OPEN;
  }

  reset() {
    const totalOpens = this._state.total_opens;
    const history = this._state.history;
    this._state = defaultState();
    this._state.total_opens = totalOpens;
    this._state.history = history;
    this._saveState();
  }

  getState() {
    return JSON.parse(JSON.stringify(this._state));
  }
}
