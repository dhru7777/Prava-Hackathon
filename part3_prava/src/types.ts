export type Variant = {
  variantId: string;
  title: string;
  price: string;
  orderable?: boolean;
};

export type OfferRow = {
  id: string;
  query: string;
  title: string;
  merchant: string;
  productId: string;
  priceEstimate: string;
  variants: Variant[];
  selectedVariantId: string | null;
  quantity: number;
  deliveryEstimate: string | null;
  quoteTotal: string | null;
  currency: string;
  checkoutSessionId: string | null;
  shipToLabel: string | null;
  status: "discovered" | "quoted" | "unshippable" | "error";
  source: "prava" | "error";
  error?: string;
};

export type QuoteResult = {
  ok: boolean;
  variantId: string;
  merchant: string;
  quantity: number;
  quoteTotal: string | null;
  currency: string;
  deliveryEstimate: string | null;
  checkoutSessionId: string | null;
  shipToLabel: string | null;
  rawError?: string;
};

/** sandbox = REST sk_test_ + CARD-03; live = CLI + real Visa */
export type PayMode = "sandbox" | "live";

export type OrderRecord = {
  id: string;
  at: string;
  title: string;
  merchant: string;
  quantity: number;
  total: string;
  currency: string;
  checkoutSessionId: string;
  paymentSessionId?: string;
  paymentUrl?: string;
  payMode?: PayMode;
  status:
    | "awaiting_passkey"
    | "polling"
    | "checking_out"
    | "paid"
    | "failed";
  orderId?: string;
  error?: string;
};

export type OffersSnapshot = {
  at: string;
  shipToLabel: string | null;
  status: "idle" | "discovering" | "ready" | "error";
  rows: OfferRow[];
  message?: string;
};
