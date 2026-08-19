import { permanentRedirect } from "next/navigation";

/** The product page moved with the catalogue it belongs to. */
export default async function StockProductRedirect({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  permanentRedirect(`/products/${productId}`);
}
