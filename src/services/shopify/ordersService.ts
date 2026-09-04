import { OrderSummary } from "../../models/order";
import { ShopifyOrderNode, ShopifyOrdersQueryData } from "../../types/shopify";
import { ShopifyClient } from "./shopifyClient";

const LATEST_ORDERS_QUERY = `
  query LatestOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
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
              }
            }
          }
        }
      }
    }
  }
`;

export class ShopifyOrdersService {
  constructor(private readonly shopifyClient: ShopifyClient) {}

  async fetchLatestOrders(limit = 10): Promise<OrderSummary[]> {
    const data = await this.shopifyClient.request<ShopifyOrdersQueryData>(
      LATEST_ORDERS_QUERY,
      { first: limit }
    );

    return data.orders.edges.map((edge) => this.mapOrder(edge.node));
  }

  private mapOrder(order: ShopifyOrderNode): OrderSummary {
    const total = order.currentTotalPriceSet.shopMoney;
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
      fulfillmentStatus: order.displayFulfillmentStatus ?? "UNFULFILLED",
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
          node.originalUnitPriceSet?.shopMoney.currencyCode ?? total.currencyCode
      })),
      bestRateCarrier: null,
      bestRateService: null,
      bestRateAmount: null,
      bestRateCurrency: null,
      fulfillmentTrackingNumber: null,
      fulfillmentLabelUrl: null,
      fulfillmentCarrier: null,
      fulfillmentService: null,
      fulfillmentShippingCost: null,
      fulfillmentCurrency: null
    };
  }
}
