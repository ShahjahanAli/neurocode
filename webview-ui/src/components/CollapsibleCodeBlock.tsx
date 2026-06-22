import { useEffect, useId, useState } from 'react';

const COLLAPSE_LINE_THRESHOLD = 5;
const PREVIEW_LINES = 2;
const EXPANDED_MAX_HEIGHT_PX = 300;

interface CollapsibleCodeBlockProps {
	code: string;
	language: string;
	filename?: string;
	streaming?: boolean;
}

/**
 * Extracts a project-relative path from common LLM code block headers.
 * @param code - Fenced block body.
 * @returns Filename hint if found.
 */
function extractFilenameFromCode(code: string): string | undefined {
	const firstLines = code.split('\n').slice(0, 3);
	for (const line of firstLines) {
		const m = line.match(/^\s*(?:\/\/|#)\s*(?:filename|file|path)\s*:\s*(.+?)\s*$/i);
		if (m?.[1]) {
			return m[1].trim();
		}
		const plain = line.match(/^\s*\/\/\s*([\w./@-]+\.[a-z0-9]+)\s*$/i);
		if (plain?.[1]) {
			return plain[1].trim();
		}
	}
	return undefined;
}

/**
 * Cursor-style compact code card — collapsed by default, expandable for full content.
 */
export function CollapsibleCodeBlock({
	code,
	language,
	filename,
	streaming = false,
}: CollapsibleCodeBlockProps) {
	const lines = code.split('\n');
	const lineCount = lines.length;
	const resolvedName = filename ?? extractFilenameFromCode(code) ?? `${language} snippet`;
	const shouldCollapse = lineCount >= COLLAPSE_LINE_THRESHOLD;

	const [expanded, setExpanded] = useState(!shouldCollapse);
	const panelId = useId();

	useEffect(() => {
		if (!shouldCollapse) {
			setExpanded(true);
		}
	}, [shouldCollapse]);

	const preview = lines.slice(0, PREVIEW_LINES).join('\n');
	const hiddenLines = Math.max(0, lineCount - PREVIEW_LINES);

	return (
		<div
			className={`code-block-card${expanded ? ' expanded' : ' collapsed'}${streaming ? ' streaming' : ''}`}
		>
			<button
				type="button"
				className="code-block-header"
				onClick={() => shouldCollapse && setExpanded((v) => !v)}
				aria-expanded={expanded}
				aria-controls={panelId}
				disabled={!shouldCollapse}
			>
				<span className="code-block-chevron" aria-hidden>
					{shouldCollapse ? (expanded ? '▼' : '▶') : '◇'}
				</span>
				<span className="code-block-file" title={resolvedName}>
					{resolvedName}
				</span>
				<span className="code-block-meta">
					{lineCount} {lineCount === 1 ? 'line' : 'lines'}
					{language !== 'text' && language !== 'plaintext' ? ` · ${language}` : ''}
				</span>
				{streaming && <span className="code-block-streaming">generating…</span>}
				{shouldCollapse && !expanded && (
					<span className="code-block-expand-hint">Click to expand</span>
				)}
			</button>

			{expanded ? (
				<pre
					id={panelId}
					className="code-block-body"
					style={{ maxHeight: `${EXPANDED_MAX_HEIGHT_PX}px` }}
				>
					<code>{code}</code>
				</pre>
			) : (
				<div id={panelId} className="code-block-preview">
					<pre><code>{preview}</code></pre>
					{hiddenLines > 0 && (
						<div className="code-block-ellipsis">
							… {hiddenLines} more {hiddenLines === 1 ? 'line' : 'lines'}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
