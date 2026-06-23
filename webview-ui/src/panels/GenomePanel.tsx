import { useEffect, useState } from 'react';
import { useVsCodeApi } from '../hooks/useVSCodeApi';

interface GenomeStatus {
	enabled: boolean;
	recordCount: number;
	lastSync: number | null;
	consentGiven?: boolean;
}

interface GenomeStats {
	totalEdits: number;
	acceptRate: number;
	avgLatency: number;
	topFiles: string[];
}

export function GenomePanel({ embedded = false }: { embedded?: boolean }) {
	const vscode = useVsCodeApi();
	const [status, setStatus] = useState<GenomeStatus | null>(null);
	const [stats, setStats] = useState<GenomeStats | null>(null);
	const [exportPath, setExportPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = (): void => {
		setLoading(true);
		vscode.postMessage({ type: 'requestGenome' });
	};

	useEffect(() => {
		refresh();
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'genomeData') {
				setStatus(e.data.status ?? null);
				setStats(e.data.stats ?? null);
				setExportPath(e.data.exportPath ?? null);
				setError(e.data.error ?? null);
				setLoading(false);
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [vscode]);

	return (
		<div className={`panel${embedded ? ' panel-embedded' : ''}`}>
			<div className="panel-header-row">
				<h3 style={{ margin: 0 }}>Edit Genome</h3>
				<button type="button" className="secondary toolbar-btn" onClick={refresh} disabled={loading}>
					Refresh
				</button>
			</div>
			<p className="panel-hint">Anonymized edit telemetry — no file paths or variable names stored.</p>
			{error && <p className="panel-error">{error}</p>}
			{loading && !status && <p className="panel-hint">Loading genome stats…</p>}
			{status && (
				<div className="genome-stats-grid">
					<div className="genome-stat">
						<span className="genome-stat-value">{status.recordCount}</span>
						<span className="genome-stat-label">Records</span>
					</div>
					<div className="genome-stat">
						<span className="genome-stat-value">{stats ? `${Math.round(stats.acceptRate * 100)}%` : '—'}</span>
						<span className="genome-stat-label">Accept rate</span>
					</div>
					<div className="genome-stat">
						<span className="genome-stat-value">{stats?.avgLatency ? `${Math.round(stats.avgLatency)}ms` : '—'}</span>
						<span className="genome-stat-label">Avg latency</span>
					</div>
					<div className="genome-stat">
						<span className={`genome-stat-value${status.enabled ? ' on' : ''}`}>
							{status.enabled ? 'On' : 'Off'}
						</span>
						<span className="genome-stat-label">Collection</span>
					</div>
				</div>
			)}
			<div className="action-row">
				<button
					type="button"
					onClick={() => vscode.postMessage({ type: 'genomeConsent', accepted: true })}
				>
					Enable consent
				</button>
				<button
					type="button"
					className="secondary"
					onClick={() => vscode.postMessage({ type: 'exportGenome' })}
				>
					Export JSONL
				</button>
			</div>
			{exportPath && (
				<p className="panel-hint">Exported to: {exportPath}</p>
			)}
		</div>
	);
}
