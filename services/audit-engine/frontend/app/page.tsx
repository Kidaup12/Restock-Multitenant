import RecentRuns from "@/components/RecentRuns";
import UploadCard from "@/components/UploadCard";

export default function HomePage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          Inventory Audit Engine
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">
          Ingests your sales and stock exports, then quantifies lost sales from
          stockouts, dead stock and capital tied up in overstock — with a full
          report and SKU-level workbook.
        </p>
      </div>
      <UploadCard />
      <RecentRuns />
    </div>
  );
}
