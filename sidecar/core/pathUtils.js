import path from 'path';

/**
 * Normalizes a filesystem path for consistent comparison (Windows-safe).
 * @param {string} filePath
 * @returns {string}
 */
export function normalizePathKey(filePath) {
	return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

/**
 * @param {string} filePath
 * @param {string} projectPath
 * @returns {boolean}
 */
export function isPathUnderProject(filePath, projectPath) {
	const fileKey = normalizePathKey(filePath);
	const projectKey = normalizePathKey(projectPath);
	const prefix = projectKey.endsWith('/') ? projectKey : `${projectKey}/`;
	return fileKey === projectKey || fileKey.startsWith(prefix);
}

/**
 * Counts indexed files belonging to a project.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectPath
 * @returns {number}
 */
export function countProjectFiles(db, projectPath) {
	if (!projectPath || !db) {
		return 0;
	}
	const rows = db.prepare('SELECT path FROM files').all();
	return rows.filter((row) => isPathUnderProject(row.path, projectPath)).length;
}
