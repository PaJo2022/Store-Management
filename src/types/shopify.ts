export interface ShopifyGraphQLError {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export interface ShopifyMoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface ShopifyMoneyBag {
  shopMoney: ShopifyMoneyV2;
}

export interface ShopifyOrderLineItemNode {
  title: string;
  quantity: number;
  originalUnitPriceSet: ShopifyMoneyBag | null;
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: ShopifyMoneyBag;
  totalOutstandingSet: ShopifyMoneyBag | null;
  paymentGatewayNames: string[];
  customer?: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  shippingAddress: {
    name: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  lineItems: {
    edges: Array<{
      node: ShopifyOrderLineItemNode;
    }>;
  };
}

export interface ShopifyOrdersQueryData {
  orders: {
    edges: Array<{
      node: ShopifyOrderNode;
    }>;
  };
}

export interface ShopifyGraphQLResponse<TData> {
  data?: TData;
  errors?: ShopifyGraphQLError[];
}
