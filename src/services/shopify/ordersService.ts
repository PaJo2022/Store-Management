import { OrderSummary } from "../../models/order";
import {
  ShopifyOrderNode,
  ShopifyOrdersQueryData,
  ShopifySingleOrderQueryData
} from "../../types/shopify";
import { ShopifyClient } from "./shopifyClient";

const ORDER_FIELDS_FRAGMENT = `
  fragment OrderFields on Order {
    id
    name
    createdAt
    cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    currentTotalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalOutstandingSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    paymentGatewayNames
    shippingAddress {
      name
      company
      address1
      address2
      city
      province
      zip
      country
      phone
    }
    lineItems(first: 100) {
      edges {
        node {
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          taxLines {
            priceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
    fulfillments(first: 5) {
      createdAt
      trackingInfo {
        number
        company
        url
      }
    }
  }
`;

const LATEST_ORDERS_QUERY = `
  ${ORDER_FIELDS_FRAGMENT}
  query LatestOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ...OrderFields
        }
      }
    }
  }
`;

const SINGLE_ORDER_QUERY = `
  ${ORDER_FIELDS_FRAGMENT}
  query SingleOrder($id: ID!) {
    order(id: $id) {
      ...OrderFields
    }
  }
`;

export interface FetchOrdersOptions {
  dateFrom?: string;
  dateTo?: string;
  maxOrders?: number;
}


const PAGE_SIZE = 250;
const DEFAULT_FULL_SYNC_CAP = 5000;

export class ShopifyOrdersService {
  constructor(private readonly shopifyClient: ShopifyClient) {}

  async fetchLatestOrders(limit = 10): Promise<OrderSummary[]> {
    return this.fetchOrders({ maxOrders: limit });
  }

  async fetchOrderById(orderId: string): Promise<OrderSummary | null> {
    const data = await this.shopifyClient.request<ShopifySingleOrderQueryData>(
      SINGLE_ORDER_QUERY,
      { id: orderId }
    );

    return data.order ? this.mapOrder(data.order) : null;
  }

  async fetchOrders(options: FetchOrdersOptions = {}): Promise<OrderSummary[]> {
    const searchQuery = this.buildDateRangeQuery(options.dateFrom, options.dateTo);
    const maxOrders = options.maxOrders ?? DEFAULT_FULL_SYNC_CAP;

    const collected: OrderSummary[] = [];
    let after: string | undefined;

    for (;;) {
      const remaining = maxOrders - collected.length;
      if (remaining <= 0) {
        break;
      }

      const data = await this.shopifyClient.request<ShopifyOrdersQueryData>(
        LATEST_ORDERS_QUERY,
        {
          first: Math.min(PAGE_SIZE, remaining),
          after,
          query: searchQuery || undefined
        }
      );

      collected.push(...data.orders.edges.map((edge) => this.mapOrder(edge.node)));

      if (!data.orders.pageInfo.hasNextPage) {
        break;
      }

      after = data.orders.pageInfo.endCursor ?? undefined;
      if (!after) {
        break;
      }
    }

    return collected;
  }

  private buildDateRangeQuery(dateFrom?: string, dateTo?: string): string {
    const parts: string[] = [];
    if (dateFrom) {
      parts.push(`created_at:>='${dateFrom}'`);
    }
    if (dateTo) {
      parts.push(`created_at:<='${dateTo}'`);
    }
    return parts.join(" ");
  }

  private mapOrder(order: ShopifyOrderNode): OrderSummary {
    const total = order.currentTotalPriceSet.shopMoney;
    const trackingEntries = order.fulfillments
      .flatMap((fulfillment) =>
        fulfillment.trackingInfo
          .filter((info) => info.number)
          .map((info) => ({ ...info, fulfillmentCreatedAt: fulfillment.createdAt }))
      )
      .sort((a, b) => Date.parse(b.fulfillmentCreatedAt) - Date.parse(a.fulfillmentCreatedAt));
    const shopifyTracking = trackingEntries[0];
    const outstandingAmountRaw =
      order.totalOutstandingSet?.shopMoney.amount ?? total.amount;
    const outstandingAmount = Number(outstandingAmountRaw);
    const financialStatus = order.displayFinancialStatus ?? "UNKNOWN";
    const gatewayNames = order.paymentGatewayNames.map((value) =>
      value.toLowerCase()
    );
    const looksLikeCod = gatewayNames.some((value) => value.includes("cod"));
    const isPartiallyPaid = financialStatus === "PARTIALLY_PAID";
    const isPending = financialStatus === "PENDING";
    const paymentPending =
      isPartiallyPaid || isPending || looksLikeCod || outstandingAmount > 0;

    return {
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      financialStatus,
      fulfillmentStatus: order.cancelledAt
        ? "CANCELLED"
        : order.displayFulfillmentStatus ?? "UNFULFILLED",
      totalPrice: total.amount,
      currencyCode: total.currencyCode,
      amountToCollect: paymentPending ? outstandingAmountRaw : "0.00",
      paymentPending,
      customer: null,
      shippingAddress: order.shippingAddress
        ? {
            name: order.shippingAddress.name ?? undefined,
            company: order.shippingAddress.company ?? undefined,
            address1: order.shippingAddress.address1 ?? undefined,
            address2: order.shippingAddress.address2 ?? undefined,
            city: order.shippingAddress.city ?? undefined,
            province: order.shippingAddress.province ?? undefined,
            zip: order.shippingAddress.zip ?? undefined,
            country: order.shippingAddress.country ?? undefined,
            phone: order.shippingAddress.phone ?? undefined
          }
        : null,
      lineItems: order.lineItems.edges.map(({ node }) => ({
        title: node.title,
        quantity: node.quantity,
        unitPrice: node.originalUnitPriceSet?.shopMoney.amount ?? "0.00",
        currencyCode:
          node.originalUnitPriceSet?.shopMoney.currencyCode ?? total.currencyCode,
        taxAmount: node.taxLines
          .reduce((sum, taxLine) => sum + Number(taxLine.priceSet.shopMoney.amount), 0)
          .toFixed(2)
      })),
      bestRateCarrier: null,
      bestRateService: null,
      bestRateAmount: null,
      bestRateCurrency: null,
      fulfillmentTrackingNumber: shopifyTracking?.number ?? null,
      fulfillmentLabelUrl: null,
      fulfillmentCarrier: shopifyTracking?.company ?? null,
      fulfillmentService: null,
      fulfillmentShippingCost: null,
      fulfillmentCurrency: null
    };
  }
}
