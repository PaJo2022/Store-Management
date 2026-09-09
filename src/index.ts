import { getEnv } from "./config/env";
import { ShopifyOrdersService } from "./services/shopify/ordersService";
import { ShopifyClient, ShopifyGraphqlError, ShopifyHttpError } from "./services/shopify/shopifyClient";
import { ShopifyFulfillmentService } from "./services/shopify/shopifyFulfillmentService";
import { createServer } from "./server/server";
import { OrdersSyncManager } from "./server/ordersSyncManager";
import { createDatabase } from "./db/database";
import { FulfillmentRepository } from "./repositories/fulfillmentRepository";
import { OrderRepository } from "./repositories/orderRepository";
import { createAmazonShippingService } from "./services/amazon/amazonShippingService";
import { BatchLabelService } from "./services/fulfillment/batchLabelService";
import { LabelStorageService } from "./services/fulfillment/labelStorageService";
import { OrderFulfillmentRepository } from "./repositories/orderFulfillmentRepository";
import { OrderFulfillmentService } from "./services/fulfillment/orderFulfillmentService";
import { ShippingPackageProfileRepository } from "./repositories/shippingPackageProfileRepository";
import { PackagingSettingsService } from "./services/settings/packagingSettingsService";

async function main(): Promise<void> {
  try {
    const env = getEnv();
    const db = await createDatabase(env.databasePath);
    const client = new ShopifyClient(env);
    const ordersService = new ShopifyOrdersService(client);
    const shopifyFulfillmentService = new ShopifyFulfillmentService(client);
    const orderRepository = new OrderRepository(db);
    const fulfillmentRepository = new FulfillmentRepository(db);
    const orderFulfillmentRepository = new OrderFulfillmentRepository(db);
    const shippingPackageProfileRepository = new ShippingPackageProfileRepository(db);
    const packagingSettingsService = new PackagingSettingsService(
      shippingPackageProfileRepository,
      {
        lengthCm: env.amazonShipping.packageLengthCm,
        widthCm: env.amazonShipping.packageWidthCm,
        heightCm: env.amazonShipping.packageHeightCm,
        weightKg: Number(env.amazonShipping.packageWeightKg)
      }
    );
    await packagingSettingsService.initializeDefaults();
    const amazonShippingService = createAmazonShippingService(env.amazonShipping, {
      getDefaultPackageSpec: async (orderId?: string) => {
        const orderProfileId = orderId
          ? await orderRepository.getPackageProfileIdForOrder(orderId)
          : null;
        const orderProfile = orderProfileId
          ? await packagingSettingsService.getProfileById(orderProfileId)
          : null;
        if (orderProfile) {
          return {
            lengthCm: orderProfile.lengthCm,
            widthCm: orderProfile.widthCm,
            heightCm: orderProfile.heightCm,
            weightKg: orderProfile.weightKg
          };
        }

        const profile = await packagingSettingsService.getEffectiveDefaultPackage();
        return {
          lengthCm: profile.lengthCm,
          widthCm: profile.widthCm,
          heightCm: profile.heightCm,
          weightKg: profile.weightKg
        };
      }
    });
    const labelStorageService = new LabelStorageService(env.labelsStoragePath);
    const orderFulfillmentService = new OrderFulfillmentService(
      orderFulfillmentRepository,
      amazonShippingService,
      labelStorageService,
      env.fulfillmentRateTtlSeconds * 1000
    );
    const syncManager = new OrdersSyncManager(
      ordersService,
      orderRepository
    );
    const batchLabelService = new BatchLabelService(
      orderRepository,
      fulfillmentRepository,
      amazonShippingService,
      labelStorageService,
      shopifyFulfillmentService
    );
    const app = createServer(
      syncManager,
      batchLabelService,
      orderFulfillmentService,
      packagingSettingsService,
      env
    );

    app.listen(env.port, () => {
      console.log(`API server running on http://localhost:${env.port}`);
    });
  } catch (error) {
    if (error instanceof ShopifyHttpError) {
      console.error(
        `Shopify HTTP error: ${error.status} ${error.statusText}`
      );
      console.error(`Request URL: ${error.requestUrl}`);
      if (error.status === 404) {
        console.error(
          "404 usually means SHOPIFY_STORE domain or SHOPIFY_API_VERSION is incorrect."
        );
      }
      console.error("Verify SHOPIFY_STORE, SHOPIFY_API_VERSION, and SHOPIFY_ACCESS_TOKEN.");
      return;
    }

    if (error instanceof ShopifyGraphqlError) {
      console.error("Shopify GraphQL error(s):");
      error.errors.forEach((entry, index) => {
        console.error(`  ${index + 1}. ${entry.message}`);
      });
      return;
    }

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      return;
    }

    console.error("Unknown error occurred.");
  }
}

void main();
