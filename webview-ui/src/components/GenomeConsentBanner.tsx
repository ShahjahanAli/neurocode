interface Props {
	onAccept: () => void;
}

export function GenomeConsentBanner({ onAccept }: Props) {
	return (
		<div className="consent-banner">
			<strong>Edit Genome</strong> — Opt in to anonymized edit telemetry to improve NeuroCode.
			<div style={{ marginTop: 8 }}>
				<button onClick={onAccept}>I consent</button>
			</div>
		</div>
	);
}
