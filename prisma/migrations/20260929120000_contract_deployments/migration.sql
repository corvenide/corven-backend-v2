-- Contracts deployed from workspaces.

-- CreateEnum
CREATE TYPE "DeployNetwork" AS ENUM ('DEVNET', 'TESTNET', 'MAINNET');

-- CreateTable
CREATE TABLE "ContractDeployment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" "DeployNetwork" NOT NULL,
    "contractName" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "outputIndex" INTEGER NOT NULL DEFAULT 0,
    "codeHash" TEXT NOT NULL,
    "hashType" TEXT NOT NULL,
    "typeId" TEXT,
    "typeArgs" TEXT,
    "dataHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "capacity" TEXT NOT NULL,
    "deployerAddress" TEXT,
    "upgradeOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractDeployment_workspaceId_createdAt_idx" ON "ContractDeployment"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ContractDeployment_typeId_idx" ON "ContractDeployment"("typeId");

-- AddForeignKey
ALTER TABLE "ContractDeployment" ADD CONSTRAINT "ContractDeployment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
