import {
  ShopifyFulfillmentCreateData,
  ShopifyFulfillmentOrdersQueryData
} from "../../types/shopify";
import { ShopifyClient } from "./shopifyClient";

const OPEN_FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            status
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const OPEN_FULFILLMENT_ORDER_STATUSES = new Set(["OPEN", "IN_PROGRESS", "SCHEDULED"]);

export interface ShopifyTrackingInput {
  orderId: string;
  trackingNumber: string;
  carrier: string;
  trackingUrl: string;
}

export interface ShopifyFulfillmentSyncResult {
  synced: boolean;
  message?: string;
}

export class ShopifyFulfillmentService {
  constructor(private readonly shopifyClient: ShopifyClient) {}

  async fulfillOrderWithTracking(
    input: ShopifyTrackingInput
  ): Promise<ShopifyFulfillmentSyncResult> {
    if (!input.orderId.startsWith("gid://shopify/Order/")) {
      return { synced: false, message: "Not a Shopify order; skipped." };
    }

    const openOrdersData = await this.shopifyClient.request<ShopifyFulfillmentOrdersQueryData>(
      OPEN_FULFILLMENT_ORDERS_QUERY,
      { orderId: input.orderId }
    );

    const openFulfillmentOrderIds = (openOrdersData.order?.fulfillmentOrders.edges ?? [])
      .filter((edge) => OPEN_FULFILLMENT_ORDER_STATUSES.has(edge.node.status))
      .map((edge) => edge.node.id);

    if (openFulfillmentOrderIds.length === 0) {
      return { synced: false, message: "No open fulfillment orders in Shopify." };
    }

    const result = await this.shopifyClient.request<ShopifyFulfillmentCreateData>(
      FULFILLMENT_CREATE_MUTATION,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: openFulfillmentOrderIds.map((fulfillmentOrderId) => ({
            fulfillmentOrderId
          })),
          trackingInfo: {
            number: input.trackingNumber,
            company: input.carrier,
            url: input.trackingUrl
          },
          notifyCustomer: true
        }
      }
    );

    const userErrors = result.fulfillmentCreate.userErrors;
    if (userErrors.length > 0) {
      return {
        synced: false,
        message: userErrors.map((error) => error.message).join("; ")
      };
    }

    return { synced: true };
  }
}
