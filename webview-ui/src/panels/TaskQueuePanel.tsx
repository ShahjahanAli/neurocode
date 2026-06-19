import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useState } from 'react';

interface Step { id: string; description: string; dependsOn: string[]; status: string }

export function TaskQueuePanel() {
	const vscode = useVsCodeApi();
	const [task, setTask] = useState('');
	const [planId, setPlanId] = useState<string | null>(null);
	const [steps, setSteps] = useState<Step[]>([]);

	const plan = () => {
		vscode.postMessage({ type: 'planTask', task });
		window.addEventListener('message', function h(e: MessageEvent) {
			if (e.data.type === 'planCreated' && e.data.data) {
				setPlanId(e.data.data.planId);
				setSteps(e.data.data.steps);
				window.removeEventListener('message', h);
			}
		});
	};

	const execute = () => {
		if (planId) vscode.postMessage({ type: 'executeStep', planId });
	};

	return (
		<div className="panel">
			<h3 style={{ margin: 0 }}>Task Queue</h3>
			<div className="input-row">
				<input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Multi-step task..." />
				<button onClick={plan}>Plan</button>
			</div>
			{steps.map((s) => (
				<div key={s.id} className={`step ${s.status}`}>
					<strong>{s.id}</strong>: {s.description}
					<div className="badge">{s.status}</div>
				</div>
			))}
			{planId && <button onClick={execute}>Execute Next Step</button>}
		</div>
	);
}
