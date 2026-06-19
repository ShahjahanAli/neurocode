import { useEffect, useState } from 'react';

interface CausalChain {
	frame: number;
	file: string;
	line: number;
	contribution: string;
}

export function DebugPanel() {
	const [result, setResult] = useState<{
		rootCauseFile?: string;
		rootCauseLine?: number;
		explanation?: string;
		causalChain?: CausalChain[];
	} | null>(null);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			if (e.data.type === 'debugResult') setResult(e.data.data);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	return (
		<div className="panel">
			<h3 style={{ margin: 0 }}>Causal Debug</h3>
			{!result ? (
				<p style={{ color: 'var(--nc-muted)' }}>Use Ctrl+Shift+D to analyze a stack trace</p>
			) : (
				<>
					<div style={{ color: '#FF4A4A', fontWeight: 600 }}>
						Root: {result.rootCauseFile}:{result.rootCauseLine}
					</div>
					<p>{result.explanation}</p>
					{result.causalChain?.map((f) => (
						<div key={f.frame} className="step">
							{f.frame}. {f.file}:{f.line} — {f.contribution}
						</div>
					))}
				</>
			)}
		</div>
	);
}
