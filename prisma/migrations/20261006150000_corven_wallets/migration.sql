-- Corven-held wallets for Google users, and their outgoing transfers.

-- CreateEnum
CREATE TYPE "WalletNetwork" AS ENUM ('TESTNET', 'MAINNET');

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" "WalletNetwork" NOT NULL,
    "address" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "wrappedDataKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "exportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "network" "WalletNetwork" NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_userId_network_key" ON "UserWallet"("userId", "network");

-- CreateIndex
CREATE INDEX "UserWallet_address_idx" ON "UserWallet"("address");

-- CreateIndex
CREATE INDEX "WalletTransfer_userId_network_createdAt_idx" ON "WalletTransfer"("userId", "network", "createdAt");

-- AddForeignKey
ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "UserWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
