import { OrderSummary } from "../models/order";

function formatAddress(order: OrderSummary): string {
  const shipping = order.shippingAddress;
  if (!shipping) {
    return "N/A";
  }

  const segments = [
    shipping.name,
    shipping.company,
    shipping.address1,
    shipping.address2,
    shipping.city,
    shipping.province,
    shipping.zip,
    shipping.country
  ].filter(Boolean);

  return segments.length > 0 ? segments.join(", ") : "N/A";
}

function formatCustomer(order: OrderSummary): string {
  if (!order.customer) {
    return "N/A";
  }

  const first = order.customer.firstName ?? "";
  const last = order.customer.lastName ?? "";
  const fullName = `${first} ${last}`.trim();

  const parts = [
    fullName || "N/A",
    order.customer.email ?? "email: N/A",
    order.customer.phone ?? "phone: N/A"
  ];

  return parts.join(" | ");
}

export function printOrders(orders: OrderSummary[]): void {
  if (orders.length === 0) {
    console.log("No orders found.");
    return;
  }

  console.log(`Fetched ${orders.length} latest order(s):`);
  console.log("=".repeat(100));

  for (const order of orders) {
    console.log(`Order: ${order.name}`);
    console.log(`Shopify ID: ${order.id}`);
    console.log(`Created: ${new Date(order.createdAt).toLocaleString()}`);
    console.log(`Payment Status: ${order.financialStatus}`);
    console.log(`Fulfillment Status: ${order.fulfillmentStatus}`);
    console.log(`Total: ${order.totalPrice} ${order.currencyCode}`);
    console.log(`Customer: ${formatCustomer(order)}`);
    console.log(`Shipping: ${formatAddress(order)}`);

    if (order.lineItems.length === 0) {
      console.log("Line Items: N/A");
    } else {
      console.log("Line Items:");
      order.lineItems.forEach((item, index) => {
        console.log(
          `  ${index + 1}. ${item.title} | qty: ${item.quantity} | unit: ${item.unitPrice} ${item.currencyCode}`
        );
      });
    }

    console.log("-".repeat(100));
  }
}
