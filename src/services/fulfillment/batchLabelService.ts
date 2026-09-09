import { FulfillmentRepository } from "../../repositories/fulfillmentRepository";
import { OrderRepository } from "../../repositories/orderRepository";
import { AmazonIntegrationError } from "../amazon/amazonLiveShippingService";
import {
  AmazonShippingService,
  ShippingRateOption
} from "../amazon/amazonShippingService";
import { LabelStorageService } from "./labelStorageService";
import { ShopifyFulfillmentService } from "../shopify/shopifyFulfillmentService";

function toAmazonTrackingUrl(trackingId: string): string {
  return `https://track.amazon.in/tracking/${encodeURIComponent(trackingId)}`;
}

interface CreateBatchInput {
  orderIds: string[];
  dryRun: boolean;
  selectedRatesByOrderId?: Record<string, string>;
}

interface RatesPreviewInput {
  orderIds: string[];
}

interface OrderRatesPreview {
  orderId: string;
  orderName: string;
  rates: ShippingRateOption[];
}

interface GenerateOrderLabelResult {
  success: true;
  orderId: string;
  groupId: string;
  alreadyExists: boolean;
  shipment: {
    shipmentId: string;
    trackingId: string;
    carrier: string;
    service: string;
    shippingCost: number;
    currencyCode: string;
    labelUrl: string;
    collectAmount: string;
  };
}

export class BatchLabelService {
  private readonly inFlightOrderLocks = new Set<string>();

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly fulfillmentRepository: FulfillmentRepository,
    private readonly amazonShippingService: AmazonShippingService,
    private readonly labelStorageService: LabelStorageService,
    private readonly shopifyFulfillmentService?: ShopifyFulfillmentService
  ) {}

  deleteStoredLabel(fileName: string): void {
    this.labelStorageService.delete(fileName);
  }

  async supersedeSuccessfulJobsForOrder(orderId: string): Promise<void> {
    await this.fulfillmentRepository.supersedeSuccessfulJobsForOrder(orderId);
  }

  async cancelShopifyFulfillment(orderId: string): Promise<{ synced: boolean; message?: string }> {
    if (!this.shopifyFulfillmentService) {
      return { synced: false, message: "Shopify fulfillment integration is unavailable." };
    }

    return this.shopifyFulfillmentService.cancelOrderFulfillments(orderId);
  }

  async attachShopifyTracking(orderId: string, trackingNumber: string, carrier: string): Promise<{ synced: boolean; message?: string }> {
    if (!this.shopifyFulfillmentService) {
      return { synced: false, message: "Shopify fulfillment integration is unavailable." };
    }

    return this.shopifyFulfillmentService.fulfillOrderWithTracking({
      orderId,
      trackingNumber,
      carrier,
      trackingUrl: toAmazonTrackingUrl(trackingNumber)
    });
  }

  private async syncShopifyFulfillment(
    orderId: string,
    trackingNumber: string,
    carrier: string
  ): Promise<void> {
    if (!this.shopifyFulfillmentService) {
      return;
    }

    try {
      const result = await this.shopifyFulfillmentService.fulfillOrderWithTracking({
        orderId,
        trackingNumber,
        carrier,
        trackingUrl: toAmazonTrackingUrl(trackingNumber)
      });

      if (!result.synced) {
        console.warn(`[shopify:fulfillment] ${orderId} not synced: ${result.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[shopify:fulfillment] ${orderId} sync failed: ${message}`);
    }
  }

  async generateOrderLabel(
    orderId: string,
    selectedRateId?: string,
    forceNew = false
  ): Promise<GenerateOrderLabelResult> {
    const normalizedOrderId = orderId.trim();
    if (!normalizedOrderId) {
      throw new Error("Order id is required.");
    }

    if (this.inFlightOrderLocks.has(normalizedOrderId)) {
      throw new Error("Label generation is already in progress for this order.");
    }

    this.inFlightOrderLocks.add(normalizedOrderId);
    try {
      const existing = await this.fulfillmentRepository.getLatestSuccessfulJobForOrder(
        normalizedOrderId
      );
      if (!forceNew && existing && existing.trackingNumber && existing.carrier && existing.labelUrl) {
        let existingLabelUrl = existing.labelUrl;
        if (existingLabelUrl.startsWith("data:application/pdf;base64,")) {
          const savedLabel = this.labelStorageService.savePdfLabel(
            normalizedOrderId,
            existing.trackingNumber,
            existingLabelUrl
          );
          existingLabelUrl = savedLabel.publicUrl;

          await this.fulfillmentRepository.updateJobResult(
            existing.batchId,
            normalizedOrderId,
            "SUCCESS",
            {
              carrier: existing.carrier,
              trackingNumber: existing.trackingNumber,
              labelUrl: existingLabelUrl,
              collectAmount: existing.collectAmount ?? "0.00"
            }
          );
        }

        await this.syncShopifyFulfillment(normalizedOrderId, existing.trackingNumber, existing.carrier);

        return {
          success: true,
          orderId: normalizedOrderId,
          groupId: existing.batchId,
          alreadyExists: true,
          shipment: {
            shipmentId: existing.id,
            trackingId: existing.trackingNumber,
            carrier: existing.carrier,
            service: existing.carrier,
            shippingCost: 0,
            currencyCode: "INR",
            labelUrl: existingLabelUrl,
            collectAmount: existing.collectAmount ?? "0.00"
          }
        };
      }

      const orders = await this.orderRepository.getOrdersByIds([normalizedOrderId]);
      const order = orders[0];
      if (!order) {
        throw new Error("No matching order found in local cache. Sync orders first.");
      }

      if (order.fulfillmentStatus?.toUpperCase() === "FULFILLED") {
        throw new Error("Order is already fulfilled in Shopify. Label generation is not allowed.");
      }

      const rates = await this.amazonShippingService.getRates(order);
      const selectedRate = selectedRateId
        ? rates.find((rate) => rate.rateId === selectedRateId) ?? this.selectBestRate(rates)
        : this.selectBestRate(rates);

      const batchResult = await this.createBatch({
        orderIds: [normalizedOrderId],
        dryRun: false,
        selectedRatesByOrderId: {
          [normalizedOrderId]: selectedRate.rateId
        }
      });

      const job = batchResult.jobs.find((entry) => entry.orderId === normalizedOrderId);
      if (!job) {
        throw new Error("Unable to locate shipment result for the selected order.");
      }

      if (job.status === "FAILED") {
        throw new Error(job.errorMessage ?? "Shipment purchase failed.");
      }

      const successfulJob =
        job.status === "SUCCESS"
          ? job
          : await this.fulfillmentRepository.getLatestSuccessfulJobForOrder(normalizedOrderId);

      if (!successfulJob?.trackingNumber || !successfulJob.carrier || !successfulJob.labelUrl) {
        throw new Error("Shipment was created without complete tracking/label details.");
      }

      return {
        success: true,
        orderId: normalizedOrderId,
        groupId: batchResult.batch.id,
        alreadyExists: job.status === "SKIPPED",
        shipment: {
          shipmentId: successfulJob.id,
          trackingId: successfulJob.trackingNumber,
          carrier: successfulJob.carrier,
          service: selectedRate.serviceName,
          shippingCost: selectedRate.amount,
          currencyCode: selectedRate.currencyCode,
          labelUrl: successfulJob.labelUrl,
          collectAmount: successfulJob.collectAmount ?? "0.00"
        }
      };
    } finally {
      this.inFlightOrderLocks.delete(normalizedOrderId);
    }
  }

  async createBatch(input: CreateBatchInput) {
    const uniqueOrderIds = Array.from(
      new Set(input.orderIds.map((value) => value.trim()).filter(Boolean))
    );

    if (uniqueOrderIds.length === 0) {
      throw new Error("At least one order id is required for batch generation.");
    }

    const orders = await this.orderRepository.getOrdersByIds(uniqueOrderIds);

    if (orders.length === 0) {
      throw new Error("No matching orders found in local cache. Sync orders first.");
    }

    const batch = await this.fulfillmentRepository.createBatch(
      orders.map((order) => order.id),
      input.dryRun
    );

    for (const order of orders) {
      try {
        const alreadyLabeled =
          await this.fulfillmentRepository.hasSuccessfulJobForOrder(order.id);
        const alreadyFulfilledInShopify = order.fulfillmentStatus?.toUpperCase() === "FULFILLED";

        if ((alreadyLabeled || alreadyFulfilledInShopify) && !input.dryRun) {
          await this.fulfillmentRepository.updateJobResult(
            batch.id,
            order.id,
            "SKIPPED",
            {
              errorMessage: alreadyLabeled
                ? "Order already has a successful label in history."
                : "Order is already fulfilled in Shopify. Label generation is not allowed."
            }
          );
          continue;
        }

        let label;
        if (input.dryRun) {
          label = await this.amazonShippingService.generateLabel(order, true);
        } else {
          // Rate IDs are tied to the request token that returned them. Fetch and
          // purchase from one quote so dashboard batches use a valid pair.
          const quote = await this.amazonShippingService.getRatesQuote(order);
          const requestedRateId = input.selectedRatesByOrderId?.[order.id];
          const selectedRate = requestedRateId
            ? quote.rates.find((rate) => rate.rateId === requestedRateId) ??
              (() => {
                throw new Error(
                  `Selected rate ${requestedRateId} is not available for ${order.name}.`
                );
              })()
            : this.selectBestRate(quote.rates);

          label = await this.amazonShippingService.purchaseShipment(
            order,
            quote.requestToken,
            selectedRate.rateId,
            quote.rates
          );
        }

        let labelUrl = label.labelDataUrl;
        if (!input.dryRun && label.labelDataUrl.startsWith("data:application/pdf;base64,")) {
          const savedLabel = this.labelStorageService.savePdfLabel(
            order.id,
            label.trackingNumber,
            label.labelDataUrl
          );
          labelUrl = savedLabel.publicUrl;
        }

        await this.fulfillmentRepository.updateJobResult(
          batch.id,
          order.id,
          "SUCCESS",
          {
            carrier: label.carrier,
            trackingNumber: label.trackingNumber,
            labelUrl,
            collectAmount: label.collectAmount
          }
        );

        if (!input.dryRun) {
          await this.syncShopifyFulfillment(order.id, label.trackingNumber, label.carrier);
        }
      } catch (error) {
        const errorMessage =
          error instanceof AmazonIntegrationError && error.details
            ? `${error.message} ${error.details}`
            : error instanceof Error
              ? error.message
              : "Unknown fulfillment error";

        await this.fulfillmentRepository.updateJobResult(
          batch.id,
          order.id,
          "FAILED",
          {
            errorMessage
          }
        );
      }
    }

    const finalBatch = await this.fulfillmentRepository.finalizeBatch(batch.id);
    const jobs = await this.fulfillmentRepository.getBatchJobs(batch.id);

    return {
      batch: finalBatch,
      jobs
    };
  }

  async getBatch(batchId: string) {
    const batch = await this.fulfillmentRepository.getBatch(batchId);
    if (!batch) {
      return null;
    }

    const jobs = await this.fulfillmentRepository.getBatchJobs(batchId);

    return {
      batch,
      jobs
    };
  }

  async listBatches() {
    const batches = await this.fulfillmentRepository.listBatches();
    return Promise.all(
      batches.map(async (batch) => ({
        batch,
        jobs: await this.fulfillmentRepository.getBatchJobs(batch.id)
      }))
    );
  }

  async previewRates(input: RatesPreviewInput): Promise<OrderRatesPreview[]> {
    const uniqueOrderIds = Array.from(
      new Set(input.orderIds.map((value) => value.trim()).filter(Boolean))
    );

    if (uniqueOrderIds.length === 0) {
      throw new Error("At least one order id is required to fetch rates.");
    }

    const orders = await this.orderRepository.getOrdersByIds(uniqueOrderIds);

    if (orders.length === 0) {
      throw new Error("No matching orders found in local cache. Sync orders first.");
    }

    const result: OrderRatesPreview[] = [];
    for (const order of orders) {
      const rates = await this.amazonShippingService.getRates(order);
      result.push({
        orderId: order.id,
        orderName: order.name,
        rates
      });
    }

    return result;
  }

  private selectBestRate(rates: ShippingRateOption[]): ShippingRateOption {
    const eligible = rates.filter((entry) => !entry.requiresAdditionalInputs);
    if (eligible.length === 0) {
      throw new Error(
        "No eligible rates available: all returned services require additional inputs."
      );
    }

    const sorted = [...eligible].sort((a, b) => {
      const aStart = this.toEpochMs(a.deliveryWindowStart);
      const bStart = this.toEpochMs(b.deliveryWindowStart);
      if (aStart !== bStart) {
        return aStart - bStart;
      }

      const aEnd = this.toEpochMs(a.deliveryWindowEnd);
      const bEnd = this.toEpochMs(b.deliveryWindowEnd);
      if (aEnd !== bEnd) {
        return aEnd - bEnd;
      }

      return a.amount - b.amount;
    });

    return sorted[0];
  }

  private toEpochMs(value: string | undefined): number {
    if (!value) {
      return Number.POSITIVE_INFINITY;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }
}
