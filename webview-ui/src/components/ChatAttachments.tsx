import { useEffect, useRef, useState } from 'react';

export interface ChatAttachment {
	path: string;
	name: string;
	kind: 'file' | 'selection';
	preview?: string;
	lineStart?: number;
	lineEnd?: number;
}

interface ChatAttachmentsProps {
	attachments: ChatAttachment[];
	maxAttachments: number;
	disabled?: boolean;
	onAttachFile: () => void;
	onAttachSelection: () => void;
	onPickFiles: () => void;
	onRemove: (index: number) => void;
}

/**
 * Cursor-style attachment bar: paperclip menu + removable context chips.
 */
export function ChatAttachments({
	attachments,
	maxAttachments,
	disabled,
	onAttachFile,
	onAttachSelection,
	onPickFiles,
	onRemove,
}: ChatAttachmentsProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const atLimit = attachments.length >= maxAttachments;

	useEffect(() => {
		if (!menuOpen) {
			return;
		}
		const close = (e: MouseEvent): void => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener('mousedown', close);
		return () => document.removeEventListener('mousedown', close);
	}, [menuOpen]);

	return (
		<div className="attachment-bar">
			{attachments.length > 0 && (
				<div className="attachment-chips">
					{attachments.map((att, index) => (
						<span
							key={`${att.kind}-${att.path}-${att.lineStart ?? 0}-${index}`}
							className={`attachment-chip attachment-chip-${att.kind}`}
							title={att.preview ?? att.path}
						>
							<span className="chip-kind">{att.kind === 'selection' ? 'Sel' : 'File'}</span>
							<span className="chip-name">{att.name}</span>
							{!disabled && (
								<button
									type="button"
									className="chip-remove"
									aria-label={`Remove ${att.name}`}
									onClick={() => onRemove(index)}
								>
									×
								</button>
							)}
						</span>
					))}
				</div>
			)}

			<div className="attachment-actions" ref={menuRef}>
				<button
					type="button"
					className="attach-btn"
					title={atLimit ? `Maximum ${maxAttachments} attachments` : 'Attach file or selection'}
					disabled={disabled || atLimit}
					onClick={() => setMenuOpen((open) => !open)}
				>
					Attach
				</button>
				{menuOpen && !disabled && !atLimit && (
					<div className="attach-menu" role="menu">
						<button type="button" role="menuitem" onClick={() => { onAttachFile(); setMenuOpen(false); }}>
							Current file
						</button>
						<button type="button" role="menuitem" onClick={() => { onAttachSelection(); setMenuOpen(false); }}>
							Editor selection
						</button>
						<button type="button" role="menuitem" onClick={() => { onPickFiles(); setMenuOpen(false); }}>
							Browse files…
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Read-only attachment chips shown on sent user messages.
 */
export function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
	if (!attachments.length) {
		return null;
	}
	return (
		<div className="message-attachments">
			{attachments.map((att, index) => (
				<span
					key={`${att.kind}-${att.path}-${index}`}
					className={`attachment-chip attachment-chip-${att.kind} readonly`}
					title={att.preview ?? att.path}
				>
					<span className="chip-kind">{att.kind === 'selection' ? 'Sel' : 'File'}</span>
					<span className="chip-name">{att.name}</span>
				</span>
			))}
		</div>
	);
}
