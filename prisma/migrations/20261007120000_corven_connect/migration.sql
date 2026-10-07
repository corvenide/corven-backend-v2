-- Corven Connect: users, sign-in identities, passkeys, sessions and wallets
-- for apps that embed the Connect SDK. Separate from Corven IDE users.

-- CreateEnum
CREATE TYPE "ConnectIdentityKind" AS ENUM ('PHONE', 'EMAIL', 'GOOGLE');

-- CreateTable
CREATE TABLE "ConnectApp" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowedOrigins" TEXT[],
    "googleClientId" TEXT,
    "loginMethods" TEXT[] DEFAULT ARRAY['PHONE', 'EMAIL', 'GOOGLE', 'PASSKEY']::TEXT[],
    "mainnetEnabled" BOOLEAN NOT NULL DEFAULT false,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectUser" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "displayName" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectIdentity" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ConnectIdentityKind" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "rpId" TEXT NOT NULL,
    "name" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "origin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectWallet" (
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

    CONSTRAINT "ConnectWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectSignature" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "network" "WalletNetwork" NOT NULL,
    "txHash" TEXT NOT NULL,
    "outflow" TEXT NOT NULL,
    "origin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectUser_appId_idx" ON "ConnectUser"("appId");
CREATE INDEX "ConnectIdentity_userId_idx" ON "ConnectIdentity"("userId");
CREATE UNIQUE INDEX "ConnectIdentity_appId_kind_value_key" ON "ConnectIdentity"("appId", "kind", "value");
CREATE UNIQUE INDEX "ConnectPasskey_credentialId_key" ON "ConnectPasskey"("credentialId");
CREATE INDEX "ConnectPasskey_userId_idx" ON "ConnectPasskey"("userId");
CREATE UNIQUE INDEX "ConnectSession_tokenHash_key" ON "ConnectSession"("tokenHash");
CREATE INDEX "ConnectSession_userId_idx" ON "ConnectSession"("userId");
CREATE INDEX "ConnectSession_familyId_idx" ON "ConnectSession"("familyId");
CREATE INDEX "ConnectWallet_address_idx" ON "ConnectWallet"("address");
CREATE UNIQUE INDEX "ConnectWallet_userId_network_key" ON "ConnectWallet"("userId", "network");
CREATE INDEX "ConnectSignature_userId_network_createdAt_idx" ON "ConnectSignature"("userId", "network", "createdAt");

-- AddForeignKey
ALTER TABLE "ConnectUser" ADD CONSTRAINT "ConnectUser_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ConnectApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectIdentity" ADD CONSTRAINT "ConnectIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ConnectUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectPasskey" ADD CONSTRAINT "ConnectPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ConnectUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectSession" ADD CONSTRAINT "ConnectSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ConnectUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectWallet" ADD CONSTRAINT "ConnectWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ConnectUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectSignature" ADD CONSTRAINT "ConnectSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ConnectUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectSignature" ADD CONSTRAINT "ConnectSignature_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "ConnectWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
