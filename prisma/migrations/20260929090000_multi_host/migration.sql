-- Multi-host scheduling: Docker hosts and the host each workspace runs on.

-- CreateEnum
CREATE TYPE "HostStatus" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateTable
CREATE TABLE "Host" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" "HostStatus" NOT NULL DEFAULT 'ONLINE',
    "draining" BOOLEAN NOT NULL DEFAULT false,
    "maxWorkspaces" INTEGER NOT NULL DEFAULT 8,
    "cpus" INTEGER,
    "memoryBytes" BIGINT,
    "containersRunning" INTEGER,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "hostId" TEXT;

-- CreateIndex
CREATE INDEX "Workspace_hostId_status_idx" ON "Workspace"("hostId", "status");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE SET NULL ON UPDATE CASCADE;
