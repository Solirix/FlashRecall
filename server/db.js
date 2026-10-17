'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSearchIndex } = require('./search');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES decks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  color TEXT,
  new_per_day INTEGER NOT NULL DEFAULT 20,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'basic' CHECK(type IN ('basic','cloze')),
  front TEXT NOT NULL DEFAULT '',
  back TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','learning','review','relearning')),
  due INTEGER NOT NULL,
  stability REAL,
  difficulty REAL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  buried INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  last_review INTEGER,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  grade INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  state_before TEXT,
  reviewed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cards_user_due ON cards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_time ON reviews(user_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_created ON notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_note_state ON cards(note_id, state, due);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

function openDatabase(dataDir) {
  const dir = dataDir || process.env.RECALL_DATA_DIR || process.env.DATA_DIR || './data';
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'recall.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  ensureSearchIndex(db);
  return db;
}

module.exports = { openDatabase };
