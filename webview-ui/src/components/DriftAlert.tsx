interface DriftItem {
	id?: number;
	file: string;
	name: string;
	distance: number;
	detectedAt?: number;
	oldSemantic?: string;
	newSemantic?: string;
}

interface DriftAlertProps {
	item: DriftItem;
	onAcknowledge?: (id: number) => void;
}

/**
 * Inline drift warning with old/new semantic context (cursorrules pattern).
 */
export function DriftAlert({ item, onAcknowledge }: DriftAlertProps) {
	const pct = Math.round(item.distance * 100);
	const fileLabel = item.file.split(/[/\\]/).pop() ?? item.file;

	return (
		<div className="drift-alert">
			<div className="drift-alert-header">
				<strong>{item.name}</strong>
				<span className="badge drift-badge">{pct}% drift</span>
			</div>
			<div className="drift-file">{fileLabel}</div>
			{(item.oldSemantic || item.newSemantic) && (
				<div className="drift-compare">
					<div className="drift-old">
						<span className="drift-label">Before</span>
						{item.oldSemantic ?? '—'}
					</div>
					<div className="drift-new">
						<span className="drift-label">After</span>
						{item.newSemantic ?? 'Semantic embedding shifted since last commit'}
					</div>
				</div>
			)}
			{!item.oldSemantic && !item.newSemantic && (
				<p className="drift-hint">Function meaning shifted since the last indexed commit.</p>
			)}
			{item.id != null && onAcknowledge && (
				<button type="button" className="secondary drift-ack" onClick={() => onAcknowledge(item.id!)}>
					Acknowledge
				</button>
			)}
		</div>
	);
}
