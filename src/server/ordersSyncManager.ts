import { OrderSummary } from "../models/order";
import { OrderRepository } from "../repositories/orderRepository";
import { ShopifyOrdersService } from "../services/shopify/ordersService";

export type OrderFilter = "all" | "open" | "fulfilled";

export interface SyncState {
  lastSyncedAt: string | null;
  totalOrders: number;
}

export interface SyncOptions {
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  fullSync?: boolean;
}

export class OrdersSyncManager {
  private lastSyncedAt: string | null = null;

  constructor(
    private readonly ordersService: ShopifyOrdersService,
    private readonly orderRepository: OrderRepository
  ) {}

  async sync(options: SyncOptions | number = 50): Promise<SyncState> {
    const normalized: SyncOptions = typeof options === "number" ? { limit: options } : options;
    const isRangeOrFullSync = normalized.fullSync || Boolean(normalized.dateFrom) || Boolean(normalized.dateTo);

    const orders = isRangeOrFullSync
      ? await this.ordersService.fetchOrders({
          dateFrom: normalized.dateFrom,
          dateTo: normalized.dateTo,
          maxOrders: normalized.limit
        })
      : await this.ordersService.fetchLatestOrders(
          Math.max(1, Math.min(normalized.limit ?? 50, 250))
        );

    this.lastSyncedAt = new Date().toISOString();
    await this.orderRepository.upsertOrders(orders, this.lastSyncedAt);

    return this.getState();
  }

  async getOrders(filter: OrderFilter): Promise<OrderSummary[]> {
    await this.sync({ fullSync: true });

    return this.orderRepository.listOrders(filter);
  }

  async getOrderById(orderId: string): Promise<OrderSummary | null> {
    const orderCount = await this.orderRepository.countOrders();
    if (orderCount === 0) {
      await this.sync({ limit: 50 });
    }

    return this.orderRepository.getOrderById(orderId);
  }

  async getOrderByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    const orderCount = await this.orderRepository.countOrders();
    if (orderCount === 0) {
      await this.sync({ limit: 50 });
    }

    return this.orderRepository.getOrderByLegacyId(legacyId);
  }

  /** Re-fetches one order from Shopify so status changed there (e.g. cancellation) reflects immediately. */
  async refreshOrderFromShopify(orderId: string): Promise<OrderSummary | null> {
    if (!orderId.startsWith("gid://shopify/Order/")) {
      return null;
    }

    const freshOrder = await this.ordersService.fetchOrderById(orderId);
    if (!freshOrder) {
      return null;
    }

    await this.orderRepository.upsertOrders([freshOrder], new Date().toISOString());
    const cachedOrder = await this.orderRepository.getOrderById(orderId);
    if (!cachedOrder) {
      return freshOrder;
    }

    // Shopify is authoritative for the current AWB; keep local label/rate data attached.
    return {
      ...cachedOrder,
      financialStatus: freshOrder.financialStatus,
      fulfillmentStatus: freshOrder.fulfillmentStatus,
      amountToCollect: freshOrder.amountToCollect,
      paymentPending: freshOrder.paymentPending,
      fulfillmentTrackingNumber: freshOrder.fulfillmentTrackingNumber ?? cachedOrder.fulfillmentTrackingNumber,
      fulfillmentTrackingUrl: freshOrder.fulfillmentTrackingUrl ?? cachedOrder.fulfillmentTrackingUrl,
      fulfillmentCarrier: freshOrder.fulfillmentCarrier ?? cachedOrder.fulfillmentCarrier,
      fulfillmentService: freshOrder.fulfillmentService ?? cachedOrder.fulfillmentService,
      lineItems: freshOrder.lineItems,
      shippingAddress: freshOrder.shippingAddress
    };
  }

  async getState(): Promise<SyncState> {
    const totalOrders = await this.orderRepository.countOrders();
    return {
      lastSyncedAt: this.lastSyncedAt,
      totalOrders
    };
  }

  async updateOrderDetailsByLegacyId(
    legacyId: string,
    customer: OrderSummary["customer"],
    shippingAddress: OrderSummary["shippingAddress"]
  ): Promise<OrderSummary | null> {
    return this.orderRepository.updateOrderDetailsByLegacyId(
      legacyId,
      customer,
      shippingAddress
    );
  }

  async updateManualFulfillmentByLegacyId(
    legacyId: string,
    details: {
      trackingNumber: string;
      trackingUrl: string;
      carrier: string;
      service: string;
    }
  ): Promise<OrderSummary | null> {
    return this.orderRepository.updateManualFulfillmentByLegacyId(legacyId, details);
  }

  async clearManualFulfillmentByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    return this.orderRepository.clearManualFulfillmentByLegacyId(legacyId);
  }

  async updatePackageProfileByLegacyId(
    legacyId: string,
    packageProfileId: string | null
  ): Promise<OrderSummary | null> {
    return this.orderRepository.updatePackageProfileByLegacyId(legacyId, packageProfileId);
  }

  async createManualOrder(input: {
    customer: NonNullable<OrderSummary["customer"]>;
    shippingAddress: NonNullable<OrderSummary["shippingAddress"]>;
    lineItems: OrderSummary["lineItems"];
    paymentPending: boolean;
    packageProfileId?: string;
  }): Promise<OrderSummary> {
    return this.orderRepository.createManualOrder(input);
  }

  async updatePaymentStatusByLegacyId(
    legacyId: string,
    status: "PENDING" | "PAID"
  ): Promise<OrderSummary | null> {
    return this.orderRepository.updatePaymentStatusByLegacyId(legacyId, status);
  }

  async cancelManualOrderByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    const order = await this.getOrderByLegacyId(legacyId);
    if (!order) {
      return null;
    }
    if (!order.id.startsWith("gid://store/ManualOrder/")) {
      throw new Error("Only manually created orders can be cancelled here.");
    }
    return this.orderRepository.updateFulfillmentStatusByLegacyId(legacyId, "CANCELLED");
  }
}
