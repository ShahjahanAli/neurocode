import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { useMemo } from 'react';
import { CollapsibleCodeBlock } from './CollapsibleCodeBlock';

interface MessageMarkdownProps {
	text: string;
	streaming?: boolean;
}

/**
 * Renders assistant markdown with collapsible fenced code blocks (Cursor-style).
 * @param props - Message text and optional streaming flag.
 */
export function MessageMarkdown({ text, streaming = false }: MessageMarkdownProps) {
	const components = useMemo<Components>(() => ({
		pre({ children }) {
			return <div className="code-block-wrapper">{children}</div>;
		},
		code({ className, children, ...props }) {
			const raw = String(children).replace(/\n$/, '');
			const fenceMatch = /language-([\w-]+)(?::(.+))?/.exec(className ?? '');
			const isBlock = Boolean(fenceMatch) || raw.includes('\n');

			if (!isBlock) {
				return (
					<code className="inline-code" {...props}>
						{children}
					</code>
				);
			}

			const language = fenceMatch?.[1] ?? 'text';
			const tagPath = fenceMatch?.[2]?.trim();

			return (
				<CollapsibleCodeBlock
					code={raw}
					language={language}
					filename={tagPath}
					streaming={streaming}
				/>
			);
		},
	}), [streaming]);

	if (!text && streaming) {
		return <span className="msg-body-empty"> </span>;
	}

	return (
		<ReactMarkdown components={components}>
			{text}
		</ReactMarkdown>
	);
}
