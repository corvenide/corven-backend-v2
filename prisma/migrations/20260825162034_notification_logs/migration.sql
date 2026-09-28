-- CreateEnum
CREATE TYPE "CellStatus" AS ENUM ('LIVE', 'DEAD');

-- CreateEnum
CREATE TYPE "ScriptKind" AS ENUM ('LOCK', 'TYPE');

-- CreateEnum
CREATE TYPE "HashType" AS ENUM ('DATA', 'TYPE', 'DATA1');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'PROPOSED', 'COMMITTED', 'REJECTED');

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "number" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "epoch" TEXT,
    "timeStamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "blockId" TEXT,
    "fee" TEXT,
    "cycles" BIGINT,
    "status" "TxStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cell" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "outputIndex" INTEGER NOT NULL,
    "outPoint" TEXT NOT NULL,
    "capacity" TEXT NOT NULL,
    "data" TEXT,
    "status" "CellStatus" NOT NULL,
    "lockScriptId" TEXT NOT NULL,
    "typeScriptId" TEXT,
    "createdByTxId" TEXT NOT NULL,
    "consumedByTxId" TEXT,
    "createdBlockId" TEXT,
    "consumedBlockId" TEXT,
    "addressId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "hashType" "HashType" NOT NULL,
    "args" TEXT NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "kind" "ScriptKind" NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "liveCapacity" TEXT NOT NULL,
    "occupiedCapacity" TEXT NOT NULL,
    "freeCapacity" TEXT NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Block_number_key" ON "Block"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Block_hash_key" ON "Block"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_hash_key" ON "Transaction"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Cell_outPoint_key" ON "Cell"("outPoint");

-- CreateIndex
CREATE UNIQUE INDEX "Script_scriptHash_key" ON "Script"("scriptHash");

-- CreateIndex
CREATE UNIQUE INDEX "Address_address_key" ON "Address"("address");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "Block"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_lockScriptId_fkey" FOREIGN KEY ("lockScriptId") REFERENCES "Script"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_typeScriptId_fkey" FOREIGN KEY ("typeScriptId") REFERENCES "Script"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_createdByTxId_fkey" FOREIGN KEY ("createdByTxId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_consumedByTxId_fkey" FOREIGN KEY ("consumedByTxId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cell" ADD CONSTRAINT "Cell_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;
