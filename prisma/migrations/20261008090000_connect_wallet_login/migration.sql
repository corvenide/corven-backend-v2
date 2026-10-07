-- Corven Connect: sign in with a wallet the user already has (JoyID,
-- MetaMask, UniSat...). Those users sign with their own wallet, so Corven
-- creates no embedded wallet for them.

-- AlterEnum
ALTER TYPE "ConnectIdentityKind" ADD VALUE 'WALLET';

-- AlterTable
ALTER TABLE "ConnectUser" ADD COLUMN "embeddedWallets" BOOLEAN NOT NULL DEFAULT true;

-- New apps offer wallet sign-in by default; so do existing ones.
ALTER TABLE "ConnectApp" ALTER COLUMN "loginMethods" SET DEFAULT ARRAY['PHONE', 'EMAIL', 'GOOGLE', 'PASSKEY', 'WALLET']::TEXT[];
UPDATE "ConnectApp" SET "loginMethods" = array_append("loginMethods", 'WALLET') WHERE NOT ('WALLET' = ANY("loginMethods"));
