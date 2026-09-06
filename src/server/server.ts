import cors from "cors";
import express from "express";
import path from "node:path";
import { AppEnv } from "../config/env";
import { AmazonIntegrationError } from "../services/amazon/amazonLiveShippingService";
import { ShopifyGraphqlError, ShopifyHttpError } from "../services/shopify/shopifyClient";
import { OrdersSyncManager, OrderFilter } from "./ordersSyncManager";
import { BatchLabelService } from "../services/fulfillment/batchLabelService";
import {
  FulfillmentWorkflowError,
  OrderFulfillmentService
} from "../services/fulfillment/orderFulfillmentService";
import { PackagingSettingsService } from "../services/settings/packagingSettingsService";

interface ApiErrorPayload {
  message: string;
  details?: string[];
}

function parseFilter(value: string | undefined): OrderFilter {
  if (value === "open" || value === "fulfilled" || value === "all") {
    return value;
  }

  return "all";
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createServer(
  syncManager: OrdersSyncManager,
  batchLabelService: BatchLabelService,
  orderFulfillmentService: OrderFulfillmentService,
  packagingSettingsService: PackagingSettingsService,
  env: AppEnv
) {
  const app = express();

  app.use(cors({ origin: env.frontendOrigin }));
  app.use(express.json());
  app.use("/api/labels", express.static(path.resolve(env.labelsStoragePath)));

  app.get("/api/health", async (_req, res) => {
    const state = await syncManager.getState();
    res.json({ ok: true, ...state });
  });

  app.get("/api/invoice/config", (_req, res) => {
    res.json({ invoiceCompany: env.invoiceCompany });
  });

  app.get("/api/settings/fulfillment-address", (_req, res) => {
    res.json({
      fulfillmentAddress: {
        name: env.amazonShipping.shipFromName,
        phone: env.amazonShipping.shipFromPhone,
        address1: env.amazonShipping.shipFromAddress1,
        address2: env.amazonShipping.shipFromAddress2,
        city: env.amazonShipping.shipFromCity,
        province: env.amazonShipping.shipFromState,
        zip: env.amazonShipping.shipFromPostalCode,
        country: env.amazonShipping.shipFromCountryCode
      }
    });
  });

  app.get("/api/settings/packaging", async (_req, res) => {
    try {
      const profiles = await packagingSettingsService.listProfiles();
      const defaultPackage = await packagingSettingsService.getEffectiveDefaultPackage();

      res.json({
        profiles,
        defaultPackage
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/settings/packaging/profiles", async (req, res) => {
    try {
      const name = readOptionalString(req.body?.name);
      const lengthCm = Number(req.body?.lengthCm);
      const widthCm = Number(req.body?.widthCm);
      const heightCm = Number(req.body?.heightCm);
      const weightKg = Number(req.body?.weightKg);
      const setAsDefault = req.body?.setAsDefault === true;

      if (!name) {
        res.status(400).json({ message: "name is required." });
        return;
      }

      const profile = await packagingSettingsService.createProfile({
        name,
        lengthCm,
        widthCm,
        heightCm,
        weightKg,
        setAsDefault
      });

      res.status(201).json({ profile });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/settings/packaging/default", async (req, res) => {
    try {
      const profileId = readOptionalString(req.body?.profileId);
      if (!profileId) {
        res.status(400).json({ message: "profileId is required." });
        return;
      }

      await packagingSettingsService.setDefaultProfile(profileId);
      const defaultPackage = await packagingSettingsService.getEffectiveDefaultPackage();
      res.json({ message: "Default package profile updated.", defaultPackage });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/orders", async (req, res) => {
    try {
      const filter = parseFilter(req.query.status as string | undefined);
      const orders = await syncManager.getOrders(filter);
      const ordersWithFulfillmentDates = await Promise.all(
        orders.map(async (order) => {
          const fulfillment = await orderFulfillmentService.getByOrderId(order.id);
          return {
            ...order,
            estimatedDeliveryStart: fulfillment?.estimatedDeliveryStart ?? null,
            estimatedDeliveryEnd: fulfillment?.estimatedDeliveryEnd ?? null
          };
        })
      );
      const state = await syncManager.getState();
      res.json({
        filter,
        count: ordersWithFulfillmentDates.length,
        shippingMode: env.amazonShipping.mode,
        ...state,
        orders: ordersWithFulfillmentDates
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/scan/lookup", async (req, res) => {
    try {
      const trackingNumber = readOptionalString(req.query.trackingNumber as string | undefined)?.toLowerCase();
      if (!trackingNumber) {
        res.status(400).json({ message: "trackingNumber is required." });
        return;
      }

      const orders = await syncManager.getOrders("all");
      const order = orders.find((candidate) =>
        candidate.fulfillmentTrackingNumber?.trim().toLowerCase() === trackingNumber
      );

      if (!order) {
        res.status(404).json({ message: "No order found for this tracking number." });
        return;
      }

      res.json({ order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/manual", async (req, res) => {
    try {
      const firstName = readOptionalString(req.body?.customer?.firstName);
      const lastName = readOptionalString(req.body?.customer?.lastName);
      const email = readOptionalString(req.body?.customer?.email);
      const phone = readOptionalString(req.body?.customer?.phone);
      const address1 = readOptionalString(req.body?.shippingAddress?.address1);
      const city = readOptionalString(req.body?.shippingAddress?.city);
      const province = readOptionalString(req.body?.shippingAddress?.province);
      const zip = readOptionalString(req.body?.shippingAddress?.zip);
      const lineItems: Array<{ title?: string; quantity: number; unitPrice: number }> = Array.isArray(req.body?.lineItems)
        ? req.body.lineItems.map((lineItem: unknown) => {
            const item = lineItem as { title?: unknown; quantity?: unknown; unitPrice?: unknown };
            return {
              title: readOptionalString(item.title),
              quantity: Number(item.quantity),
              unitPrice: Number(item.unitPrice)
            };
          })
        : [];
      const paymentPending = req.body?.paymentPending === true;
      let packageProfileId = readOptionalString(req.body?.packageProfileId);
      const customPackage = req.body?.customPackage;

      if (!firstName || !address1 || !city || !province || !zip || lineItems.length === 0 || lineItems.some((item) => !item.title || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0)) {
        res.status(400).json({ message: "Provide customer, complete shipping address, and at least one item with a positive quantity and price." });
        return;
      }
      if (customPackage) {
        const profile = await packagingSettingsService.createProfile({
          name: readOptionalString(customPackage.name) ?? `Order box ${new Date().toISOString()}`,
          lengthCm: Number(customPackage.lengthCm),
          widthCm: Number(customPackage.widthCm),
          heightCm: Number(customPackage.heightCm),
          weightKg: Number(customPackage.weightKg),
          setAsDefault: false
        });
        packageProfileId = profile.id;
      }
      if (packageProfileId && !(await packagingSettingsService.getProfileById(packageProfileId))) {
        res.status(400).json({ message: "Package profile not found." });
        return;
      }

      const order = await syncManager.createManualOrder({
        customer: { firstName, lastName, email, phone },
        shippingAddress: {
          name: [firstName, lastName].filter(Boolean).join(" "),
          address1,
          address2: readOptionalString(req.body?.shippingAddress?.address2),
          city,
          province,
          zip,
          country: readOptionalString(req.body?.shippingAddress?.country) ?? "India",
          phone
        },
        lineItems: lineItems.map((item) => ({
          title: item.title!,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toFixed(2),
          currencyCode: "INR"
        })),
        paymentPending,
        packageProfileId
      });

      await orderFulfillmentService.primeBestRates([order]);
      const savedOrder = await syncManager.getOrderById(order.id);
      res.status(201).json({ message: "Manual order created.", order: savedOrder ?? order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/orders/:legacyId", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);

      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      try {
        const refreshed = await syncManager.refreshOrderFromShopify(order.id);
        res.json({ order: refreshed ?? order });
      } catch (refreshError) {
        console.warn(
          `[shopify:refresh] ${order.id} failed, serving cached order: ${
            refreshError instanceof Error ? refreshError.message : "Unknown error"
          }`
        );
        res.json({ order });
      }
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/orders/:legacyId", async (req, res) => {
    try {
      const shippingInput = req.body?.shippingAddress;
      const customerInput = req.body?.customer;

      const firstName = readOptionalString(customerInput?.firstName);
      const lastName = readOptionalString(customerInput?.lastName);
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

      const updated = await syncManager.updateOrderDetailsByLegacyId(
        req.params.legacyId,
        {
          firstName,
          lastName,
          email: readOptionalString(customerInput?.email),
          phone: readOptionalString(customerInput?.phone)
        },
        {
          name: fullName || readOptionalString(shippingInput?.name),
          company: readOptionalString(shippingInput?.company),
          address1: readOptionalString(shippingInput?.address1),
          address2: readOptionalString(shippingInput?.address2),
          city: readOptionalString(shippingInput?.city),
          province: readOptionalString(shippingInput?.province),
          zip: readOptionalString(shippingInput?.zip),
          country: readOptionalString(shippingInput?.country),
          phone:
            readOptionalString(shippingInput?.phone) ??
            readOptionalString(customerInput?.phone)
        }
      );

      if (!updated) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      res.json({ message: "Order details updated.", order: updated });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/orders/:legacyId/package", async (req, res) => {
    try {
      const packageProfileId = readOptionalString(req.body?.packageProfileId);
      if (packageProfileId) {
        const profile = await packagingSettingsService.getProfileById(packageProfileId);
        if (!profile) {
          res.status(400).json({ message: "Package profile not found." });
          return;
        }
      }

      const order = await syncManager.updatePackageProfileByLegacyId(
        req.params.legacyId,
        packageProfileId ?? null
      );
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      res.json({ message: "Order package saved.", order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/orders/:legacyId/payment-status", async (req, res) => {
    try {
      const status = readOptionalString(req.body?.financialStatus)?.toUpperCase();
      if (status !== "PENDING" && status !== "PAID") {
        res.status(400).json({ message: "financialStatus must be PENDING or PAID." });
        return;
      }

      const order = await syncManager.updatePaymentStatusByLegacyId(req.params.legacyId, status);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      res.json({ message: "Order payment status updated.", order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/orders/:legacyId/rate", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      const rateId = readOptionalString(req.body?.rateId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }
      if (!rateId) {
        res.status(400).json({ message: "rateId is required." });
        return;
      }

      const rate = await orderFulfillmentService.selectStoredRate(order.id, rateId);
      const updatedOrder = await syncManager.getOrderByLegacyId(req.params.legacyId);
      res.json({ message: "Selected shipping rate saved.", order: updatedOrder, rate });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/:legacyId/rates/refresh", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const rates = await orderFulfillmentService.refreshBestRatesForOrder(order);
      const updatedOrder = await syncManager.getOrderByLegacyId(req.params.legacyId);
      res.json({ message: "Rates refreshed.", order: updatedOrder, rates });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.put("/api/orders/:legacyId/fulfillment-details", async (req, res) => {
    try {
      const packageProfileId = readOptionalString(req.body?.packageProfileId);
      const financialStatus = readOptionalString(req.body?.financialStatus)?.toUpperCase();
      const trackingNumber = readOptionalString(req.body?.trackingNumber);
      const trackingUrl = readOptionalString(req.body?.trackingUrl);
      const carrier = readOptionalString(req.body?.carrier);
      const service = readOptionalString(req.body?.service);
      if (financialStatus !== "PENDING" && financialStatus !== "PAID") {
        res.status(400).json({ message: "financialStatus must be PENDING or PAID." });
        return;
      }

      if (packageProfileId && !(await packagingSettingsService.getProfileById(packageProfileId))) {
        res.status(400).json({ message: "Package profile not found." });
        return;
      }

      if (trackingNumber || trackingUrl || carrier || service) {
        if (!trackingNumber || !trackingUrl || !carrier || !service) {
          res.status(400).json({ message: "Tracking number, tracking URL, carrier, and service are required together." });
          return;
        }
        try {
          new URL(trackingUrl);
        } catch {
          res.status(400).json({ message: "trackingUrl must be a valid URL." });
          return;
        }
      }

      const packageUpdated = await syncManager.updatePackageProfileByLegacyId(
        req.params.legacyId,
        packageProfileId ?? null
      );
      if (!packageUpdated) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const paymentUpdated = await syncManager.updatePaymentStatusByLegacyId(
        req.params.legacyId,
        financialStatus
      );
      if (!paymentUpdated) {
        throw new Error("Order payment status could not be updated.");
      }

      if (trackingNumber && trackingUrl && carrier && service) {
        const trackingUpdated = await syncManager.updateManualFulfillmentByLegacyId(
          req.params.legacyId,
          { trackingNumber, trackingUrl, carrier, service }
        );
        if (!trackingUpdated) {
          throw new Error("Order tracking details could not be saved.");
        }
      }

      const rateOrder = {
        ...paymentUpdated,
        financialStatus,
        paymentPending: financialStatus === "PENDING",
        amountToCollect:
          financialStatus === "PAID" ? "0.00" : paymentUpdated.amountToCollect
      };
      const rates = await orderFulfillmentService.refreshBestRatesForOrder(rateOrder);
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      res.json({ message: "Order changes saved and rates refreshed.", order, rates });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/order", async (req, res) => {
    try {
      const orderId =
        typeof req.query.id === "string" ? req.query.id.trim() : "";

      if (!orderId) {
        res.status(400).json({ message: "Missing required query parameter: id" });
        return;
      }

      const order = await syncManager.getOrderById(orderId);

      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      res.json({ order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/sync", async (req, res) => {
    try {
      const dateFrom = readOptionalString(req.body?.dateFrom);
      const dateTo = readOptionalString(req.body?.dateTo);
      const fullSync = req.body?.fullSync === true;
      const requestedLimit =
        typeof req.body?.limit === "number" ? req.body.limit : undefined;

      const state = await syncManager.sync({
        limit: requestedLimit,
        dateFrom,
        dateTo,
        fullSync
      });
      res.json({
        message: "Orders synced successfully.",
        ...state
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/:legacyId/generate-label", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const fulfillment = await batchLabelService.generateOrderLabel(
        order.id,
        readOptionalString(req.body?.selectedRateId),
        req.body?.forceNew === true
      );
      const result = {
        success: fulfillment.success,
        orderId: fulfillment.orderId,
        groupId: fulfillment.groupId,
        alreadyExists: fulfillment.alreadyExists,
        shipment: fulfillment.shipment
      };
      res.json(result);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/:legacyId/cancel", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }
      if (!order.id.startsWith("gid://store/ManualOrder/")) {
        res.status(400).json({ message: "Only manually created orders can be cancelled here." });
        return;
      }
      await orderFulfillmentService.cancelOrder(order);
      const updatedOrder = await syncManager.cancelManualOrderByLegacyId(req.params.legacyId);
      res.json({ message: "Manual order cancelled.", order: updatedOrder });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.delete("/api/orders/:legacyId/fulfillment", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const refreshedOrder = order.id.startsWith("gid://shopify/Order/")
        ? await syncManager.refreshOrderFromShopify(order.id)
        : order;
      const latestOrder = refreshedOrder ?? order;

      let orderForReset = latestOrder;
      if (latestOrder.fulfillmentStatus?.toUpperCase() === "FULFILLED") {
        const cancelled = await batchLabelService.cancelShopifyFulfillment(latestOrder.id);
        if (!cancelled.synced) {
          res.status(409).json({
            alreadyFulfilled: true,
            order: latestOrder,
            message: cancelled.message ?? "Shopify fulfillment could not be cancelled."
          });
          return;
        }
        orderForReset = (await syncManager.refreshOrderFromShopify(latestOrder.id)) ?? latestOrder;
      }

      const fulfillment = await orderFulfillmentService.getByOrderId(orderForReset.id);
      const previousAwb = {
        trackingNumber: orderForReset.fulfillmentTrackingNumber ?? fulfillment?.amazonTrackingId ?? null,
        carrier: orderForReset.fulfillmentCarrier ?? fulfillment?.amazonCarrier ?? null,
        service: orderForReset.fulfillmentService ?? fulfillment?.amazonService ?? null,
        labelUrl: orderForReset.fulfillmentLabelUrl ?? fulfillment?.labelStoragePath ?? null,
        shippingCost: orderForReset.fulfillmentShippingCost ?? fulfillment?.shippingCharge ?? 0,
        currencyCode: orderForReset.fulfillmentCurrency ?? fulfillment?.currency ?? orderForReset.currencyCode,
        collectAmount: orderForReset.paymentPending ? orderForReset.amountToCollect : "0.00"
      };
      await batchLabelService.supersedeSuccessfulJobsForOrder(orderForReset.id);
      await orderFulfillmentService.resetForRegeneration(orderForReset.id);

      const updatedOrder = await syncManager.clearManualFulfillmentByLegacyId(req.params.legacyId);
      res.json({ message: "Shopify and local AWB details reset. Choose whether to reuse the previous AWB or create a fresh Amazon shipment.", order: updatedOrder ?? orderForReset, previousAwb });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/:legacyId/fulfillment/attach", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      const trackingNumber = readOptionalString(req.body?.trackingNumber);
      const carrier = readOptionalString(req.body?.carrier);
      if (!order || !trackingNumber || !carrier) {
        res.status(400).json({ message: "Order, tracking number, and carrier are required." });
        return;
      }

      const result = await batchLabelService.attachShopifyTracking(order.id, trackingNumber, carrier);
      if (!result.synced) {
        res.status(409).json({ message: result.message ?? "The previous AWB could not be attached to Shopify." });
        return;
      }

      const refreshedOrder = await syncManager.refreshOrderFromShopify(order.id);
      res.json({ message: "Previous AWB attached to Shopify.", order: refreshedOrder ?? order });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/orders/:legacyId/fulfillment", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const result = await orderFulfillmentService.fulfillOrder(order);
      res.json({ fulfillment: result });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/orders/:legacyId/fulfillment", async (req, res) => {
    try {
      const order = await syncManager.getOrderByLegacyId(req.params.legacyId);
      if (!order) {
        res.status(404).json({ message: "Order not found." });
        return;
      }

      const record = await orderFulfillmentService.getByOrderId(order.id);
      if (!record) {
        res.status(404).json({ message: "Fulfillment record not found." });
        return;
      }

      res.json({ fulfillment: record });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/fulfillments/:id", async (req, res) => {
    try {
      const record = await orderFulfillmentService.getById(req.params.id);
      if (!record) {
        res.status(404).json({ message: "Fulfillment record not found." });
        return;
      }

      res.json({ fulfillment: record });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/fulfillments/:id/label", async (req, res) => {
    try {
      const record = await orderFulfillmentService.getById(req.params.id);
      if (!record || !record.labelStoragePath) {
        res.status(404).json({ message: "Label not found." });
        return;
      }

      res.redirect(record.labelStoragePath);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/fulfillment/batches", async (req, res) => {
    try {
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds.filter((value: unknown) => typeof value === "string")
        : [];
      const dryRun = false;
      const selectedRatesByOrderId =
        req.body?.selectedRatesByOrderId &&
        typeof req.body.selectedRatesByOrderId === "object"
          ? Object.fromEntries(
              Object.entries(req.body.selectedRatesByOrderId).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string"
              )
            )
          : undefined;

      const result = await batchLabelService.createBatch({
        orderIds,
        dryRun,
        selectedRatesByOrderId
      });
      res.status(201).json(result);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.get("/api/labels/groups", async (_req, res) => {
    try {
      const groups = await batchLabelService.listBatches();
      const result = await Promise.all(
        groups.map(async ({ batch, jobs }) => ({
          ...batch,
          groupId: `labels-${batch.id}`,
          jobs: await Promise.all(
            jobs.map(async (job) => ({
              ...job,
              order: await syncManager.getOrderById(job.orderId)
            }))
          )
        }))
      );
      res.json({
        groups: result.filter((group) =>
          group.jobs.some((job) => job.status === "SUCCESS" && Boolean(job.labelUrl))
        )
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  app.post("/api/fulfillment/rates", async (req, res) => {
    try {
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds.filter((value: unknown) => typeof value === "string")
        : [];

      console.log(
        `[api:/api/fulfillment/rates] request orderIds=${JSON.stringify(orderIds)}`
      );

      const rates = await batchLabelService.previewRates({ orderIds });
      console.log(
        `[api:/api/fulfillment/rates] success count=${rates.length}`
      );
      res.json({
        count: rates.length,
        rates
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          `[api:/api/fulfillment/rates] failure message=${error.message}`
        );
      }
      sendApiError(res, error);
    }
  });

  app.get("/api/fulfillment/batches/:batchId", async (req, res) => {
    try {
      const result = await batchLabelService.getBatch(req.params.batchId);

      if (!result) {
        res.status(404).json({ message: "Batch not found." });
        return;
      }

      res.json(result);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return app;
}

function sendApiError(res: express.Response, error: unknown): void {
  if (error instanceof ShopifyHttpError) {
    const responseDetail = error.responseBody.trim();
    const payload: ApiErrorPayload = {
      message: `Shopify HTTP error: ${error.status} ${error.statusText}`,
      details: responseDetail ? [responseDetail] : undefined
    };

    res.status(502).json(payload);
    return;
  }

  if (error instanceof ShopifyGraphqlError) {
    const payload: ApiErrorPayload = {
      message: "Shopify GraphQL error.",
      details: error.errors.map((entry) => entry.message)
    };

    res.status(502).json(payload);
    return;
  }

  if (error instanceof AmazonIntegrationError) {
    const payload: ApiErrorPayload = {
      message: error.message,
      details: error.details ? [error.details] : undefined
    };
    res.status(error.statusCode ?? 502).json(payload);
    return;
  }

  if (error instanceof FulfillmentWorkflowError) {
    const payload: ApiErrorPayload = {
      message: error.message,
      details: [error.code]
    };

    if (error.code === "FULFILLMENT_IN_PROGRESS") {
      res.status(409).json(payload);
      return;
    }

    if (error.code === "VALIDATION_ERROR") {
      res.status(400).json(payload);
      return;
    }

    if (error.code === "SHIPMENT_ALREADY_EXISTS") {
      res.status(200).json(payload);
      return;
    }

    if (error.code === "UNKNOWN_PURCHASE_RESULT") {
      res.status(502).json(payload);
      return;
    }

    res.status(502).json(payload);
    return;
  }

  if (error instanceof Error) {
    if (error.message.includes("required") || error.message.includes("No matching orders")) {
      res.status(400).json({ message: error.message });
      return;
    }

    res.status(500).json({ message: error.message });
    return;
  }

  res.status(500).json({ message: "Unknown server error." });
}
