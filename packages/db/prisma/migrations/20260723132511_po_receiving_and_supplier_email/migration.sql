-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_predictionId_fkey";

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "predictionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "expectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "receivedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "email" TEXT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
