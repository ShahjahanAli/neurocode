import { useVsCodeApi } from '../hooks/useVSCodeApi';

export type FileChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface PendingFileChange {
	file: string;
	status: FileChangeStatus;
}

export interface ChangeReviewSummary {
	messageId: string;
	files: PendingFileChange[];
	reviewStatus: 'pending' | 'accepted' | 'rejected' | 'partial';
}

interface ChangeReviewBarProps {
	messageId: string;
	sourceText?: string;
	text: string;
	shardFiles?: string[];
	changeReview?: ChangeReviewSummary;
	filesApplied?: Array<{ file: string; action: 'created' | 'updated' }>;
	truncated?: boolean;
}

/**
 * Cursor-style accept / reject bar for proposed code changes.
 */
export function ChangeReviewBar({
	messageId,
	sourceText,
	text,
	shardFiles,
	changeReview,
	filesApplied,
	truncated,
}: ChangeReviewBarProps) {
	const vscode = useVsCodeApi();

	const files = changeReview?.files ?? [];
	const pending = files.filter((f) => f.status === 'pending');
	const hasPending = pending.length > 0;
	const allAccepted = changeReview?.reviewStatus === 'accepted'
		|| (filesApplied && filesApplied.length > 0 && !hasPending);
	const allRejected = changeReview?.reviewStatus === 'rejected';

	if (files.length === 0 && (!filesApplied || filesApplied.length === 0)) {
		return null;
	}

	const post = (type: string, file?: string): void => {
		vscode.postMessage({
			type,
			messageId,
			file,
			text,
			sourceText,
			shardFiles,
		});
	};

	return (
		<div className="change-review-bar">
			<div className="change-review-header">
				<span className="change-review-title">
					{allAccepted && 'Changes applied'}
					{allRejected && 'Changes rejected'}
					{hasPending && `Proposed changes (${pending.length} file${pending.length === 1 ? '' : 's'})`}
					{!hasPending && !allAccepted && !allRejected && changeReview?.reviewStatus === 'partial' && 'Partially reviewed'}
				</span>
				{hasPending && !truncated && (
					<div className="change-review-actions">
						<button
							type="button"
							className="change-btn accept"
							onClick={() => post('acceptChange')}
							title="Apply all proposed changes"
						>
							Accept All
						</button>
						<button
							type="button"
							className="change-btn reject"
							onClick={() => post('rejectChange')}
							title="Discard all proposed changes"
						>
							Reject All
						</button>
					</div>
				)}
			</div>

			<ul className="change-review-files">
				{files.map((f) => (
					<li key={f.file} className={`change-review-file status-${f.status}`}>
						<span className="change-file-path" title={f.file}>{f.file}</span>
						<span className={`change-file-status status-${f.status}`}>
							{f.status === 'accepted' && 'Applied'}
							{f.status === 'rejected' && 'Rejected'}
							{f.status === 'pending' && 'Pending'}
						</span>
						{f.status === 'pending' && (
							<div className="change-file-actions">
								<button type="button" className="change-btn sm" onClick={() => post('reviewChange', f.file)}>
									Review
								</button>
								<button type="button" className="change-btn sm accept" onClick={() => post('acceptChange', f.file)}>
									Accept
								</button>
								<button type="button" className="change-btn sm reject" onClick={() => post('rejectChange', f.file)}>
									Reject
								</button>
							</div>
						)}
					</li>
				))}
				{files.length === 0 && filesApplied?.map((f) => (
					<li key={f.file} className="change-review-file status-accepted">
						<span className="change-file-path">{f.file}</span>
						<span className="change-file-status status-accepted">{f.action}</span>
					</li>
				))}
			</ul>

			{truncated && hasPending && (
				<p className="change-review-hint">Finish generation before accepting changes.</p>
			)}
		</div>
	);
}
