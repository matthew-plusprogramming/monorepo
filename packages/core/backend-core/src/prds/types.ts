/**
 * PRD (Product Requirements Document) Types
 *
 * Defines types for PRD entities synced from Google Docs.
 * Supports version tracking with content hashing.
 */

/**
 * Represents a PRD entity in DynamoDB.
 */
export type Prd = {
  readonly id: string;
  readonly googleDocId: string;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly version: number;
  readonly lastSyncedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly syncStatus: PrdSyncStatusType;
  readonly lastSyncError?: string;
};

/**
 * Valid sync statuses for a PRD.
 */
export const PrdSyncStatus = {
  SYNCED: 'SYNCED',
  SYNCING: 'SYNCING',
  ERROR: 'ERROR',
  NEVER_SYNCED: 'NEVER_SYNCED',
} as const;

export type PrdSyncStatusType = (typeof PrdSyncStatus)[keyof typeof PrdSyncStatus];

/**
 * Input for creating a new PRD.
 */
export type CreatePrdInput = {
  readonly id: string;
  readonly googleDocId: string;
  readonly title: string;
  readonly createdBy: string;
};

/**
 * Input for syncing a PRD from Google Docs.
 */
export type SyncPrdInput = {
  readonly prdId: string;
};

/**
 * Result from syncing a PRD.
 */
export type SyncPrdResult = {
  readonly prd: Prd;
  readonly contentChanged: boolean;
  readonly previousVersion: number;
};

/**
 * Google Doc content response.
 */
export type GoogleDocContent = {
  readonly title: string;
  readonly content: string;
};
