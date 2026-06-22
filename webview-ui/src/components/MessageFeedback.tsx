import { useVsCodeApi } from '../hooks/useVSCodeApi';
import { useState } from 'react';

interface MessageFeedbackProps {
	messageId: string;
	taskPreview?: string;
	responsePreview: string;
	intent?: string;
	provider?: string;
	modelUsed?: string;
	tokensUsed?: number;
	latencyMs?: number;
	shards?: Array<{ file: string; reason: string; tokenCount: number }>;
	initialRating?: 'positive' | 'negative';
}

/**
 * Cursor-style thumbs up/down feedback on assistant messages.
 */
export function MessageFeedback({
	messageId,
	taskPreview,
	responsePreview,
	intent,
	provider,
	modelUsed,
	tokensUsed,
	latencyMs,
	shards,
	initialRating,
}: MessageFeedbackProps) {
	const vscode = useVsCodeApi();
	const [rating, setRating] = useState<'positive' | 'negative' | null>(initialRating ?? null);
	const [showComment, setShowComment] = useState(false);
	const [comment, setComment] = useState('');
	const [submitted, setSubmitted] = useState(Boolean(initialRating));

	const submit = (nextRating: 'positive' | 'negative', withComment = false): void => {
		if (submitted) {
			return;
		}
		setRating(nextRating);
		if (nextRating === 'negative' && !withComment) {
			setShowComment(true);
			return;
		}
		vscode.postMessage({
			type: 'submitFeedback',
			messageId,
			rating: nextRating,
			comment: withComment ? comment.trim() : undefined,
			taskPreview,
			responsePreview: responsePreview.slice(0, 2000),
			intent,
			provider,
			modelUsed,
			tokensUsed,
			latencyMs,
			diagnostics: {
				shardCount: shards?.length ?? 0,
				shards: shards?.slice(0, 8),
			},
		});
		setSubmitted(true);
		setShowComment(false);
	};

	if (submitted) {
		return (
			<div className="msg-feedback msg-feedback-done">
				<span>Thanks for the feedback{rating === 'positive' ? ' 👍' : ''}</span>
			</div>
		);
	}

	return (
		<div className="msg-feedback">
			<span className="msg-feedback-label">Was this helpful?</span>
			<button
				type="button"
				className={`feedback-btn${rating === 'positive' ? ' active' : ''}`}
				title="Good response"
				aria-label="Good response"
				onClick={() => submit('positive', true)}
			>
				👍
			</button>
			<button
				type="button"
				className={`feedback-btn${rating === 'negative' ? ' active' : ''}`}
				title="Poor response"
				aria-label="Poor response"
				onClick={() => submit('negative')}
			>
				👎
			</button>
			{showComment && (
				<div className="feedback-comment-box">
					<textarea
						value={comment}
						onChange={(e) => setComment(e.target.value)}
						placeholder="What went wrong? (optional — helps improve NeuroCode)"
						rows={2}
					/>
					<button type="button" className="hub-btn sm primary" onClick={() => submit('negative', true)}>
						Send feedback
					</button>
					<button type="button" className="hub-btn sm secondary" onClick={() => submit('negative', true)}>
						Skip
					</button>
				</div>
			)}
		</div>
	);
}
