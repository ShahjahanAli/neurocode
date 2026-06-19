const REASON_COLORS: Record<string, string> = {
	'active file': '#7C6FF7',
	import: '#4A9EFF',
	caller: '#FF9B4A',
	'semantic match': '#4AFF9B',
};

interface Props {
	file: string;
	reason: string;
	tokenCount: number;
	budget?: number;
}

export function ShardCard({ file, reason, tokenCount, budget }: Props) {
	const pct = budget ? (tokenCount / budget) * 100 : 0;
	const color = Object.entries(REASON_COLORS).find(([k]) => reason.includes(k))?.[1] ?? '#888';

	return (
		<div className="shard-card">
			<div style={{ display: 'flex', justifyContent: 'space-between' }}>
				<span>{file}</span>
				<span className="badge" style={{ borderColor: color }}>{tokenCount} tok</span>
			</div>
			<div className="shard-reason">{reason}</div>
			{budget && (
				<div className="budget-bar" style={{ marginTop: 4 }}>
					<div className="budget-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
				</div>
			)}
		</div>
	);
}
