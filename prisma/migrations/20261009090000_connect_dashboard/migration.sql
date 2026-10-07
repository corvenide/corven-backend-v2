-- Corven Connect dashboard: app teams (Corven IDE accounts), invites and
-- usage events for stats.

-- CreateEnum
CREATE TYPE "ConnectAppRole" AS ENUM ('OWNER', 'ADMIN', 'VIEWER');
CREATE TYPE "ConnectEventKind" AS ENUM ('SIGN_UP', 'SIGN_IN', 'CODE_SENT', 'TX_SIGNED');

-- AlterTable
ALTER TABLE "ConnectApp" ADD COLUMN "createdById" TEXT;

-- CreateTable
CREATE TABLE "ConnectAppMember" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ConnectAppRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectAppMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectAppInvite" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "email" TEXT,
    "role" "ConnectAppRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectAppInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectEvent" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "kind" "ConnectEventKind" NOT NULL,
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectAppMember_appId_userId_key" ON "ConnectAppMember"("appId", "userId");
CREATE INDEX "ConnectAppMember_userId_idx" ON "ConnectAppMember"("userId");
CREATE UNIQUE INDEX "ConnectAppInvite_tokenHash_key" ON "ConnectAppInvite"("tokenHash");
CREATE INDEX "ConnectAppInvite_appId_idx" ON "ConnectAppInvite"("appId");
CREATE INDEX "ConnectEvent_appId_createdAt_idx" ON "ConnectEvent"("appId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConnectAppMember" ADD CONSTRAINT "ConnectAppMember_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ConnectApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectAppInvite" ADD CONSTRAINT "ConnectAppInvite_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ConnectApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectEvent" ADD CONSTRAINT "ConnectEvent_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ConnectApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
