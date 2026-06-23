import { TaskNode } from '../components/TaskNode';
import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useEffect, useState } from 'react';

interface Step {
	id: string;
	description: string;
	dependsOn: string[];
	status: string;
}

export function TaskQueuePanel({ embedded = false }: { embedded?: boolean }) {
	const vscode = useVsCodeApi();
	const [task, setTask] = useState('');
	const [planId, setPlanId] = useState<string | null>(null);
	const [steps, setSteps] = useState<Step[]>([]);
	const [executing, setExecuting] = useState(false);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'planCreated' && e.data.data) {
				setPlanId(e.data.data.planId);
				setSteps(e.data.data.steps ?? []);
			}
			if (e.data.type === 'stepResult' && e.data.data?.stepId) {
				setSteps((prev) => prev.map((s) => (
					s.id === e.data.data.stepId
						? { ...s, status: e.data.data.status ?? 'done' }
						: s
				)));
				setExecuting(false);
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	const doneIds = new Set(steps.filter((s) => s.status === 'done').map((s) => s.id));

	const plan = (): void => {
		if (!task.trim()) {
			return;
		}
		vscode.postMessage({ type: 'planTask', task });
	};

	const executeNext = (): void => {
		if (!planId || executing) {
			return;
		}
		const next = steps.find((s) =>
			s.status === 'pending' && s.dependsOn.every((dep) => doneIds.has(dep)),
		);
		if (!next) {
			return;
		}
		setExecuting(true);
		setSteps((prev) => prev.map((s) => (
			s.id === next.id ? { ...s, status: 'running' } : s
		)));
		vscode.postMessage({ type: 'executeStep', planId });
	};

	return (
		<div className={`panel${embedded ? ' panel-embedded' : ''}`}>
			<h3 style={{ margin: 0 }}>Task Queue</h3>
			<p className="panel-hint">Multi-step plans respect dependency order (DAG).</p>
			<div className="input-row">
				<input
					value={task}
					onChange={(e) => setTask(e.target.value)}
					placeholder="Multi-step task…"
					onKeyDown={(e) => e.key === 'Enter' && plan()}
				/>
				<button type="button" onClick={plan}>Plan</button>
			</div>

			{steps.length > 0 && (
				<div className="task-dag">
					{steps.map((s) => {
						const blocked = s.dependsOn.some((dep) => !doneIds.has(dep));
						const isNext = s.status === 'pending' && !blocked;
						return (
							<TaskNode
								key={s.id}
								id={s.id}
								description={s.description}
								status={s.status}
								dependsOn={s.dependsOn}
								isBlocked={blocked}
								onExecute={isNext ? executeNext : undefined}
							/>
						);
					})}
				</div>
			)}

			{planId && steps.some((s) => s.status === 'pending') && (
				<div className="action-row">
					<button type="button" onClick={executeNext} disabled={executing}>
						{executing ? 'Running…' : 'Execute next step'}
					</button>
				</div>
			)}
		</div>
	);
}
