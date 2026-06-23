import { useEffect, useMemo, useRef, useState } from 'react';

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
 * @param model - Gateway model entry.
 * @param query - Lowercase search string.
 * @returns Whether the model matches the query.
 */
function modelMatchesQuery(model: ListedModel, query: string): boolean {
	if (!query) {
		return true;
	}
	const id = model.id.toLowerCase();
	const owner = model.owned_by?.toLowerCase() ?? '';
	return id.includes(query) || owner.includes(query);
}

/**
 * Cursor-style model picker with Auto + searchable gateway model list.
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
	const [search, setSearch] = useState('');
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

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

	useEffect(() => {
		if (!open) {
			setSearch('');
			return;
		}
		const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
		return () => window.clearTimeout(timer);
	}, [open]);

	const query = search.trim().toLowerCase();
	const filteredModels = useMemo(
		() => models.filter((m) => modelMatchesQuery(m, query)),
		[models, query],
	);

	const label = modelSelection === 'auto'
		? (activeModel ? `Auto · ${activeModel}` : 'Auto')
		: (selectedModel || 'Select model');

	const openMenu = (): void => {
		setOpen((v) => !v);
	};

	const selectAuto = (): void => {
		onChange('auto');
		setOpen(false);
	};

	const selectModel = (id: string): void => {
		onChange('manual', id);
		setOpen(false);
	};

	return (
		<div className="model-picker" ref={rootRef}>
			<button
				type="button"
				className="model-picker-trigger"
				disabled={disabled}
				onClick={openMenu}
				title="Choose LLM model"
				aria-expanded={open}
				aria-haspopup="listbox"
			>
				<span className="model-picker-label">{loading ? 'Models…' : label}</span>
				<span className="model-picker-caret">▾</span>
			</button>
			{open && !disabled && (
				<div className="model-picker-menu" role="listbox" aria-label="LLM models">
					<div className="model-picker-header">
						<button
							type="button"
							className={`model-picker-item${modelSelection === 'auto' ? ' active' : ''}`}
							onClick={selectAuto}
						>
							<strong>Auto</strong>
							<span className="model-picker-hint">Best model per task</span>
						</button>
						{models.length > 0 && (
							<input
								ref={searchRef}
								type="search"
								className="model-picker-search"
								placeholder="Search models…"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										e.stopPropagation();
										if (search) {
											setSearch('');
										} else {
											setOpen(false);
										}
									}
								}}
								aria-label="Search models"
							/>
						)}
					</div>
					<div className="model-picker-list">
						{models.length === 0 && (
							<div className="model-picker-empty">No models from gateway — check apiBaseUrl</div>
						)}
						{models.length > 0 && query && filteredModels.length === 0 && (
							<div className="model-picker-empty">No models match &quot;{search.trim()}&quot;</div>
						)}
						{filteredModels.map((m) => (
							<button
								key={m.id}
								type="button"
								role="option"
								aria-selected={modelSelection === 'manual' && selectedModel === m.id}
								className={`model-picker-item${modelSelection === 'manual' && selectedModel === m.id ? ' active' : ''}`}
								onClick={() => selectModel(m.id)}
							>
								<span className="model-picker-id">{m.id}</span>
								{m.owned_by && <span className="model-picker-hint">{m.owned_by}</span>}
							</button>
						))}
					</div>
					<div className="model-picker-footer">
						{models.length > 0 && (
							<span className="model-picker-count">
								{query ? `${filteredModels.length} / ${models.length}` : models.length} models
							</span>
						)}
						<button type="button" className="secondary toolbar-btn" onClick={onRefresh}>
							Refresh list
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
