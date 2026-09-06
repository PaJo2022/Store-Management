export interface Address {
  name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

export interface CustomerInfo {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export interface OrderLineItem {
  title: string;
  quantity: number;
  unitPrice: string;
  currencyCode: string;
  taxAmount?: string;
}

export interface OrderSummary {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  totalPrice: string;
  currencyCode: string;
  amountToCollect: string;
  paymentPending: boolean;
  customer: CustomerInfo | null;
  shippingAddress: Address | null;
  lineItems: OrderLineItem[];
  bestRateCarrier?: string | null;
  bestRateService?: string | null;
  bestRateAmount?: number | null;
  bestRateCurrency?: string | null;
  fulfillmentTrackingNumber?: string | null;
  fulfillmentTrackingUrl?: string | null;
  fulfillmentLabelUrl?: string | null;
  fulfillmentCarrier?: string | null;
  fulfillmentService?: string | null;
  fulfillmentShippingCost?: number | null;
  fulfillmentCurrency?: string | null;
  estimatedDeliveryStart?: string | null;
  estimatedDeliveryEnd?: string | null;
  packageProfileId?: string | null;
}
