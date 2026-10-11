/** Read-only exchange observations, not proof that an ambiguous request was never sent. */
export interface RecoveryEvidence {
  checkedAt: number;
  orderStatus: string;
  openOrderCount: number;
  matchingHistoricalOrderCount: number;
  historicalOrdersTruncated: boolean;
  fillsSinceIntentCount: number;
  fillsComplete: boolean;
  actualPerp: number | null;
  eligible: boolean;
  blockers: string[];
  observation: string;
}

export interface RecoveryReview {
  id: string;
  createdAt: number;
  expiresAt: number;
  underlying: string;
  clientOrderId: string;
  quantity: number;
  intentCreatedAt: number;
  evidence: RecoveryEvidence;
  warning: string;
}

export interface RecoveryConfirmation {
  reviewId: string;
  clientOrderId: string;
  acknowledgeUnknown: true;
}
