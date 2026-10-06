-- Google sign-in: a new auth provider and the Google account id on User.

-- AlterEnum
ALTER TYPE "AuthProvider" ADD VALUE 'GOOGLE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
