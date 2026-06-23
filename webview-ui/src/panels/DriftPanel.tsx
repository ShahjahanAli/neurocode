import { useEffect, useState } from 'react';
import { DriftAlert } from '../components/DriftAlert';
import { useVsCodeApi } from '../hooks/useVSCodeApi';

interface DriftItem {
	id?: number;
	file: string;
	name: string;
	distance: number;
	detectedAt?: number;
}

export function DriftPanel({ embedded = false }: { embedded?: boolean }) {
	const vscode = useVsCodeApi();
	const [items, setItems] = useState<DriftItem[]>([]);
	const [enabled, setEnabled] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = (): void => {
		setLoading(true);
		vscode.postMessage({ type: 'requestDrift' });
	};

	useEffect(() => {
		refresh();
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'driftData') {
				setItems(e.data.data?.driftedFunctions ?? []);
				setEnabled(e.data.enabled !== false);
				setError(e.data.error ?? null);
				setLoading(false);
			}
			if (e.data.type === 'driftAcknowledged') {
				refresh();
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [vscode]);

	const acknowledge = (id: number): void => {
		vscode.postMessage({ type: 'acknowledgeDrift', alertId: id });
	};

	return (
		<div className={`panel${embedded ? ' panel-embedded' : ''}`}>
			<div className="panel-header-row">
				<h3 style={{ margin: 0 }}>Semantic Drift</h3>
				<button type="button" className="secondary toolbar-btn" onClick={refresh} disabled={loading}>
					Refresh
				</button>
			</div>
			{!enabled && (
				<p className="panel-hint">Drift detection is disabled in settings.</p>
			)}
			{error && <p className="panel-error">{error}</p>}
			{loading && items.length === 0 && !error && (
				<p className="panel-hint">Loading drift alerts…</p>
			)}
			{!loading && items.length === 0 && !error && (
				<p className="panel-hint">No unacknowledged drift detected. Alerts appear after git commits when symbol embeddings shift.</p>
			)}
			{items.map((item) => (
				<DriftAlert
					key={`${item.id ?? item.file}-${item.name}`}
					item={item}
					onAcknowledge={item.id != null ? acknowledge : undefined}
				/>
			))}
		</div>
	);
}
