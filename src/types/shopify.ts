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
  taxLines: Array<{
    priceSet: ShopifyMoneyBag;
  }>;
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
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
  fulfillments: Array<{
    createdAt: string;
    trackingInfo: Array<{
      number: string | null;
      company: string | null;
      url: string | null;
    }>;
  }>;
}

export interface ShopifyOrdersQueryData {
  orders: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: Array<{
      node: ShopifyOrderNode;
    }>;
  };
}

export interface ShopifySingleOrderQueryData {
  order: ShopifyOrderNode | null;
}

export interface ShopifyFulfillmentOrdersQueryData {
  order: {
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
        };
      }>;
    };
  } | null;
}

export interface ShopifyFulfillmentCreateData {
  fulfillmentCreate: {
    fulfillment: {
      id: string;
      status: string;
    } | null;
    userErrors: Array<{
      field: string[] | null;
      message: string;
    }>;
  };
}

export interface ShopifyGraphQLResponse<TData> {
  data?: TData;
  errors?: ShopifyGraphQLError[];
}
