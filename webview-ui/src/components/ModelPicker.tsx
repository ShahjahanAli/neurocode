import { useEffect, useRef, useState } from 'react';

interface ListedModel {
	id: string;
	owned_by?: string;
}

interface ModelPickerProps {
	modelSelection: 'auto' | 'manual';
	selectedModel: string;
	models: ListedModel[];
	activeModel?: string | null;
	loading?: boolean;
	disabled?: boolean;
	onChange: (selection: 'auto' | 'manual', model?: string) => void;
	onRefresh: () => void;
}

/**
 * Cursor-style model picker with Auto + gateway model list.
 */
export function ModelPicker({
	modelSelection,
	selectedModel,
	models,
	activeModel,
	loading,
	disabled,
	onChange,
	onRefresh,
}: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const close = (e: MouseEvent): void => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	}, [open]);

	const label = modelSelection === 'auto'
		? (activeModel ? `Auto · ${activeModel}` : 'Auto')
		: (selectedModel || 'Select model');

	return (
		<div className="model-picker" ref={rootRef}>
			<button
				type="button"
				className="model-picker-trigger"
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				title="Choose LLM model"
			>
				<span className="model-picker-label">{loading ? 'Models…' : label}</span>
				<span className="model-picker-caret">▾</span>
			</button>
			{open && !disabled && (
				<div className="model-picker-menu" role="listbox">
					<button
						type="button"
						className={`model-picker-item${modelSelection === 'auto' ? ' active' : ''}`}
						onClick={() => { onChange('auto'); setOpen(false); }}
					>
						<strong>Auto</strong>
						<span className="model-picker-hint">Best model per task</span>
					</button>
					<div className="model-picker-divider" />
					{models.length === 0 && (
						<div className="model-picker-empty">No models from gateway — check apiBaseUrl</div>
					)}
					{models.map((m) => (
						<button
							key={m.id}
							type="button"
							className={`model-picker-item${modelSelection === 'manual' && selectedModel === m.id ? ' active' : ''}`}
							onClick={() => { onChange('manual', m.id); setOpen(false); }}
						>
							<span className="model-picker-id">{m.id}</span>
							{m.owned_by && <span className="model-picker-hint">{m.owned_by}</span>}
						</button>
					))}
					<div className="model-picker-footer">
						<button type="button" className="secondary toolbar-btn" onClick={onRefresh}>
							Refresh list
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
