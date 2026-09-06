import { randomUUID } from "node:crypto";
import { AmazonShippingConfig } from "../../config/env";
import { OrderSummary } from "../../models/order";
import { AmazonLiveShippingService } from "./amazonLiveShippingService";

export interface PackageSpec {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
}

export interface PackageSettingsProvider {
  getDefaultPackageSpec(orderId?: string): Promise<PackageSpec>;
}

export interface ShippingRateOption {
  rateId: string;
  carrierName: string;
  serviceName: string;
  serviceId: string;
  amount: number;
  currencyCode: string;
  requiresAdditionalInputs: boolean;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  valueAddedServices?: Array<{ id: string }>;
}

export interface ShippingRatesQuote {
  requestToken: string;
  rates: ShippingRateOption[];
}

export interface GeneratedLabel {
  shipmentId: string;
  carrier: string;
  service: string;
  rateId: string;
  requestToken: string;
  trackingNumber: string;
  labelDataUrl: string;
  labelFormat: string;
  labelContentType: string;
  collectAmount: string;
}

export interface AmazonShippingService {
  getRatesQuote(order: OrderSummary): Promise<ShippingRatesQuote>;
  getRates(order: OrderSummary): Promise<ShippingRateOption[]>;
  purchaseShipment(
    order: OrderSummary,
    requestToken: string,
    selectedRateId: string,
    rates?: ShippingRateOption[]
  ): Promise<GeneratedLabel>;
  generateLabel(
    order: OrderSummary,
    dryRun: boolean,
    selectedRateId?: string
  ): Promise<GeneratedLabel>;
}

export class MockAmazonShippingService implements AmazonShippingService {
  async getRatesQuote(order: OrderSummary): Promise<ShippingRatesQuote> {
    const rates = await this.getRates(order);
    return {
      requestToken: `mock-request-${randomUUID().slice(0, 8)}`,
      rates
    };
  }

  async getRates(order: OrderSummary): Promise<ShippingRateOption[]> {
    const baseAmount = Number(order.totalPrice) * 0.12;
    return [
      {
        rateId: "mock-standard",
        carrierName: "Amazon Shipping",
        serviceName: "Mock Standard",
        serviceId: "MOCK-STANDARD",
        amount: Number.isFinite(baseAmount) ? Number(baseAmount.toFixed(2)) : 99,
        currencyCode: order.currencyCode,
        requiresAdditionalInputs: false
      },
      {
        rateId: "mock-express",
        carrierName: "Amazon Shipping",
        serviceName: "Mock Express",
        serviceId: "MOCK-EXPRESS",
        amount: Number.isFinite(baseAmount) ? Number((baseAmount * 1.45).toFixed(2)) : 149,
        currencyCode: order.currencyCode,
        requiresAdditionalInputs: false
      }
    ];
  }

  async purchaseShipment(
    order: OrderSummary,
    requestToken: string,
    selectedRateId: string,
    rates?: ShippingRateOption[]
  ): Promise<GeneratedLabel> {
    const legacyOrderId = order.id.split("/").pop() ?? order.id;
    const suffix = randomUUID().split("-")[0].toUpperCase();
    const availableRates = rates ?? (await this.getRates(order));
    const selectedRate =
      availableRates.find((entry) => entry.rateId === selectedRateId) ??
      availableRates[0];

    return {
      shipmentId: `mock-shipment-${suffix}`,
      carrier: selectedRate?.carrierName ?? "Amazon Shipping",
      service: selectedRate?.serviceName ?? "Mock Standard",
      rateId: selectedRate?.rateId ?? selectedRateId,
      requestToken,
      trackingNumber: `AMZ${legacyOrderId}${suffix}`,
      labelDataUrl: `data:application/pdf;base64,${Buffer.from("Mock PDF label").toString("base64")}`,
      labelFormat: "PDF",
      labelContentType: "application/pdf",
      collectAmount: order.paymentPending && Number.isFinite(Number(order.amountToCollect)) && Number(order.amountToCollect) > 0
        ? Number(order.amountToCollect).toFixed(2)
        : "0.00"
    };
  }

  async generateLabel(
    order: OrderSummary,
    dryRun: boolean,
    selectedRateId?: string
  ): Promise<GeneratedLabel> {
    const quote = await this.getRatesQuote(order);
    const selected = selectedRateId ?? quote.rates[0]?.rateId ?? "mock-standard";
    const purchased = await this.purchaseShipment(order, quote.requestToken, selected, quote.rates);
    if (dryRun) {
      return {
        ...purchased,
        carrier: "Amazon Shipping (Dry Run)",
        service: "Dry Run"
      };
    }

    return purchased;
  }
}

export function createAmazonShippingService(
  config: AmazonShippingConfig,
  packageSettingsProvider?: PackageSettingsProvider
): AmazonShippingService {
  if (config.mode === "live" || config.mode === "sandbox") {
    return new AmazonLiveShippingService(config, packageSettingsProvider);
  }

  return new MockAmazonShippingService();
}
