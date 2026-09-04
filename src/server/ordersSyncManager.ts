import { OrderSummary } from "../models/order";
import { OrderRepository } from "../repositories/orderRepository";
import { ShopifyOrdersService } from "../services/shopify/ordersService";

interface RatesPrimer {
  primeBestRates(orders: OrderSummary[]): Promise<void>;
}

export type OrderFilter = "all" | "open" | "fulfilled";

export interface SyncState {
  lastSyncedAt: string | null;
  totalOrders: number;
}

export class OrdersSyncManager {
  private lastSyncedAt: string | null = null;

  constructor(
    private readonly ordersService: ShopifyOrdersService,
    private readonly orderRepository: OrderRepository,
    private readonly ratesPrimer?: RatesPrimer
  ) {}

  async sync(limit = 50): Promise<SyncState> {
    const safeLimit = Math.max(1, Math.min(limit, 250));
    const orders = await this.ordersService.fetchLatestOrders(safeLimit);
    this.lastSyncedAt = new Date().toISOString();
    await this.orderRepository.upsertOrders(orders, this.lastSyncedAt);
    if (this.ratesPrimer) {
      await this.ratesPrimer.primeBestRates(orders);
    }

    return this.getState();
  }

  async getOrders(filter: OrderFilter): Promise<OrderSummary[]> {
    const orderCount = await this.orderRepository.countOrders();
    if (orderCount === 0) {
      await this.sync(50);
    }

    return this.orderRepository.listOrders(filter);
  }

  async getOrderById(orderId: string): Promise<OrderSummary | null> {
    const orderCount = await this.orderRepository.countOrders();
    if (orderCount === 0) {
      await this.sync(50);
    }

    return this.orderRepository.getOrderById(orderId);
  }

  async getOrderByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    const orderCount = await this.orderRepository.countOrders();
    if (orderCount === 0) {
      await this.sync(50);
    }

    return this.orderRepository.getOrderByLegacyId(legacyId);
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
