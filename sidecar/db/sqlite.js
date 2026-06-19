import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {DatabaseSync | null} */
let db = null;

/**
 * Opens or returns the SQLite database for the current project.
 * @param {string} projectPath - Absolute workspace root.
 * @returns {DatabaseSync}
 */
export function getDb(projectPath) {
	if (db) {
		return db;
	}

	const neuroDir = path.join(projectPath || process.cwd(), '.neurocode');
	fs.mkdirSync(neuroDir, { recursive: true });

	const dbPath = path.join(neuroDir, 'neurocode.db');
	db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');

	const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
	db.exec(schema);

	return db;
}

/** Closes the database connection cleanly. */
export function closeDb() {
	if (db) {
		db.close();
		db = null;
	}
}
