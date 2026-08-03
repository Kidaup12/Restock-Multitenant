-- AlterTable
ALTER TABLE "ShopifyConnection" ADD COLUMN     "authFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAuthError" TEXT,
ADD COLUMN     "lastAuthErrorAt" TIMESTAMP(3),
ADD COLUMN     "syncPausedAt" TIMESTAMP(3);
