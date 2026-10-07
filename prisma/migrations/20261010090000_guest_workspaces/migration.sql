-- Guest sessions and temporary workspaces.
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'GUEST';

ALTER TABLE "Workspace" ADD COLUMN "temporary" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Workspace_temporary_status_idx" ON "Workspace"("temporary", "status");
