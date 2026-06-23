interface TaskNodeProps {
	id: string;
	description: string;
	status: string;
	dependsOn: string[];
	isBlocked: boolean;
	onExecute?: () => void;
}

const STATUS_ICON: Record<string, string> = {
	pending: '○',
	running: '◐',
	done: '✓',
	failed: '✕',
};

/**
 * DAG step node for the task queue (cursorrules TaskNode pattern).
 */
export function TaskNode({
	id,
	description,
	status,
	dependsOn,
	isBlocked,
	onExecute,
}: TaskNodeProps) {
	return (
		<div className={`task-node status-${status}${isBlocked ? ' blocked' : ''}`}>
			<div className="task-node-head">
				<span className="task-node-icon" aria-hidden>{STATUS_ICON[status] ?? '○'}</span>
				<strong className="task-node-id">{id}</strong>
				<span className="badge">{status}</span>
			</div>
			<p className="task-node-desc">{description}</p>
			{dependsOn.length > 0 && (
				<div className="task-node-deps">
					Depends on: {dependsOn.join(', ')}
				</div>
			)}
			{status === 'pending' && !isBlocked && onExecute && (
				<button type="button" className="task-node-run" onClick={onExecute}>
					Run step
				</button>
			)}
		</div>
	);
}
