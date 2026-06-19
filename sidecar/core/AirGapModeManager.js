import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const INTERNAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Blocks external HTTP when air-gap mode is enabled.
 */
export class AirGapModeManager {
	/**
	 * @param {string} projectPath
	 * @param {boolean} auditLog
	 */
	constructor(projectPath, auditLog = true) {
		this.projectPath = projectPath;
		this.auditLog = auditLog;
		this.logPath = path.join(projectPath, '.neurocode', '.neurocode-airgap-audit.log');
		fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
	}

	/**
	 * Patches http/https request to block external hosts.
	 */
	enforce() {
		this._patchModule(http);
		this._patchModule(https);
		this.log('Air-gap mode enforced');
	}

	/**
	 * @param {string} message
	 */
	log(message) {
		if (!this.auditLog) {
			return;
		}
		const line = `[${new Date().toISOString()}] ${message}\n`;
		fs.appendFileSync(this.logPath, line);
	}

	/**
	 * @param {typeof http} mod
	 */
	_patchModule(mod) {
		const original = mod.request.bind(mod);
		const self = this;

		mod.request = function airgapRequest(...args) {
			const url = typeof args[0] === 'string' ? args[0] : args[0]?.href ?? args[0]?.hostname;
			if (!self._isAllowed(url)) {
				self.log(`BLOCKED: ${url}`);
				throw new Error(`Air-gap mode: external request blocked to ${url}`);
			}
			return original(...args);
		};
	}

	/**
	 * @param {string} url
	 * @returns {boolean}
	 */
	_isAllowed(url) {
		if (!url) {
			return true;
		}
		const str = String(url);
		if (INTERNAL_HOSTS.some((h) => str.includes(h))) {
			return true;
		}
		if (/192\.168\.\d+\.\d+/.test(str) || /10\.\d+\.\d+\.\d+/.test(str)) {
			return true;
		}
		return false;
	}
}
