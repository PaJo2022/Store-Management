import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { PDFDocument } from 'pdf-lib'
import './App.css'

type OrderFilter = 'all' | 'open' | 'fulfilled'

interface OrderLineItem {
  title: string
  quantity: number
  unitPrice: string
  currencyCode: string
}

interface ShippingAddress {
  name?: string
  company?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  zip?: string
  country?: string
  phone?: string
}

interface CustomerInfo {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
}

interface OrderSummary {
  id: string
  name: string
  createdAt: string
  financialStatus: string
  fulfillmentStatus: string
  totalPrice: string
  currencyCode: string
  amountToCollect: string
  paymentPending: boolean
  customer: CustomerInfo | null
  shippingAddress: ShippingAddress | null
  lineItems: OrderLineItem[]
  bestRateCarrier: string | null
  bestRateService: string | null
  bestRateAmount: number | null
  bestRateCurrency: string | null
  fulfillmentTrackingNumber?: string | null
  fulfillmentLabelUrl?: string | null
  fulfillmentCarrier?: string | null
  fulfillmentService?: string | null
  fulfillmentShippingCost?: number | null
  fulfillmentCurrency?: string | null
  packageProfileId?: string | null
}

interface OrdersResponse {
  filter: OrderFilter
  count: number
  shippingMode?: 'mock' | 'sandbox' | 'live'
  lastSyncedAt: string | null
  totalOrders: number
  orders: OrderSummary[]
}

interface InvoiceCompanyConfig {
  legalName: string
  addressLine1: string
  addressLine2?: string
  city: string
  state: string
  postalCode: string
  country: string
  phone: string
  email: string
  gstin: string
  vat?: string
  fssai?: string
  defaultTaxRatePercent: number
}

const HARD_CODED_INVOICE_COMPANY: InvoiceCompanyConfig = {
  legalName: 'Bose Enterprise',
  addressLine1: '191, Ramkrishna Road',
  addressLine2: 'Kolkata, 700131',
  city: 'Kolkata',
  state: 'West Bengal',
  postalCode: '700131',
  country: 'India',
  phone: '9038338983',
  email: 'support@wobblebag.com',
  gstin: '19BRUPB9557M1ZQ',
  vat: '',
  fssai: '',
  defaultTaxRatePercent: 18
}

interface SyncResponse {
  message: string
  lastSyncedAt: string | null
  totalOrders: number
}

interface FulfillmentBatch {
  id: string
  createdAt: string
  status: 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS'
  dryRun: boolean
  totalOrders: number
  successCount: number
  failedCount: number
  skippedCount: number
}

interface FulfillmentJob {
  id: string
  orderId: string
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'
  carrier: string | null
  trackingNumber: string | null
  labelUrl: string | null
  collectAmount: string | null
  errorMessage: string | null
}

interface FulfillmentBatchResponse {
  batch: FulfillmentBatch
  jobs: FulfillmentJob[]
}

interface ShippingRateOption {
  rateId: string
  carrierName: string
  serviceName: string
  serviceId: string
  amount: number
  currencyCode: string
  requiresAdditionalInputs: boolean
  deliveryWindowStart?: string
  deliveryWindowEnd?: string
}

interface OrderRatesPreview {
  orderId: string
  orderName: string
  rates: ShippingRateOption[]
}

interface FulfillmentRatesResponse {
  count: number
  rates: OrderRatesPreview[]
}

interface GeneratedShipment {
  shipmentId: string
  trackingId: string
  carrier: string
  service: string
  shippingCost: number
  currencyCode: string
  labelUrl: string
  collectAmount: string
}

interface GenerateLabelResponse {
  success: boolean
  orderId: string
  alreadyExists: boolean
  shipment: GeneratedShipment
  message?: string
}

interface LabelGroup extends FulfillmentBatch {
  groupId: string
  jobs: Array<FulfillmentJob & { order: OrderSummary | null }>
}

interface OrderUpdatePayload {
  customer: {
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
  }
  shippingAddress: {
    name?: string
    company?: string
    address1?: string
    address2?: string
    city?: string
    province?: string
    zip?: string
    country?: string
    phone?: string
  }
}

interface PackageProfile {
  id: string
  name: string
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
  isDefault: boolean
}

interface DefaultPackage {
  id: string | null
  name: string
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
}

interface PackagingSettingsResponse {
  profiles: PackageProfile[]
  defaultPackage: DefaultPackage
}

interface AddressEditForm {
  firstName: string
  lastName: string
  company: string
  phone: string
  email: string
  address1: string
  address2: string
  city: string
  province: string
  zip: string
  country: string
}

interface ManualOrderForm {
  firstName: string
  lastName: string
  email: string
  phone: string
  address1: string
  address2: string
  city: string
  province: string
  zip: string
  country: string
  lineItems: Array<{ title: string; quantity: string; unitPrice: string }>
  paymentPending: boolean
  packageProfileId: string
  useCustomPackage: boolean
  customPackageName: string
  customLengthCm: string
  customWidthCm: string
  customHeightCm: string
  customWeightKg: string
}

function createPreviewUrlFromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    return null
  }

  const mimeType = match[1]
  const base64Payload = match[2]

  try {
    const binary = atob(base64Payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const blob = new Blob([bytes], { type: mimeType })
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

function toAbsoluteLabelUrl(labelUrl: string): string {
  if (/^https?:\/\//i.test(labelUrl) || labelUrl.startsWith('data:') || labelUrl.startsWith('blob:')) {
    return labelUrl
  }

  return `${window.location.origin}${labelUrl.startsWith('/') ? labelUrl : `/${labelUrl}`}`
}

function toAmazonTrackingUrl(trackingId: string): string {
  return `https://track.amazon.in/tracking/${encodeURIComponent(trackingId)}`
}

function LabelPreview({ labelUrl, orderId }: { labelUrl: string; orderId: string }) {
  const previewUrl = useMemo(() => {
    if (!labelUrl.startsWith('data:')) {
      return labelUrl
    }

    return createPreviewUrlFromDataUrl(labelUrl)
  }, [labelUrl])

  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  if (!previewUrl) {
    return <p className="muted">Label preview unavailable</p>
  }

  const isPdf = labelUrl.includes('application/pdf')
  const isImage = labelUrl.includes('image/png') || labelUrl.includes('image/jpeg')

  return (
    <div className="label-preview">
      {isPdf ? (
        <iframe title={`label-${orderId}`} src={previewUrl} className="label-preview-frame" />
      ) : isImage ? (
        <img src={previewUrl} alt={`Shipping label for ${orderId}`} className="label-preview-image" />
      ) : (
        <p className="muted">Preview not supported for this label format.</p>
      )}
      <a href={previewUrl} target="_blank" rel="noreferrer" className="details-link">
        Open Label
      </a>
    </div>
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatMoney(value: number, currencyCode: string): string {
  const amount = Number.isFinite(value) ? value : 0
  if (currencyCode.toUpperCase() === 'INR') {
    return `Rs. ${amount.toFixed(2)}`
  }

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 2
  }).format(amount)
}

function buildInvoiceHtml(
  sourceOrders: OrderSummary[],
  company: InvoiceCompanyConfig
): string {
  const defaultPaymentGateway = 'Razorpay - UPI, Cards, Wallets, NB'

  const toStateCode = (value: string | undefined): string => {
    const raw = (value ?? '').trim()
    if (raw.length === 0) {
      return '-'
    }

    if (raw.length <= 3) {
      return raw.toUpperCase()
    }

    return raw
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 3)
  }

  const toWordsSimple = (value: number): string => {
    const rounded = Math.round(Number.isFinite(value) ? value : 0)
    return `${rounded} RUPEES ONLY`
  }

  const pages = sourceOrders
    .map((order, orderIndex) => {
      const rate = company.defaultTaxRatePercent / 100
      const rows = order.lineItems.map((item) => {
        const qty = Number(item.quantity) || 0
        const unit = Number(item.unitPrice) || 0
        const lineTotal = qty * unit
        return {
          title: item.title,
          qty,
          unit,
          lineTotal
        }
      })

      const itemSubtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)
      const grandTotal = Number(order.totalPrice) || itemSubtotal
      const totalBeforeTax = grandTotal / (1 + rate)
      const totalTax = grandTotal - totalBeforeTax
      const totalAfterTax = grandTotal
      const shippingAmount = 0
      const shippingTax = 0
      const shippingTotal = shippingAmount + shippingTax
      const discountAmount = 0
      const totalRefunded = 0
      const totalOutstanding = order.paymentPending ? Number(order.amountToCollect) || 0 : 0
      const companyState = company.state.trim().toLowerCase()
      const orderState = (order.shippingAddress?.province ?? '').trim().toLowerCase()
      const isIntraState = companyState.length > 0 && orderState.length > 0 && companyState === orderState
      const cgstAmount = isIntraState ? totalTax / 2 : 0
      const sgstAmount = isIntraState ? totalTax / 2 : 0
      const igstAmount = isIntraState ? 0 : totalTax
      const billAddress = order.shippingAddress
      const invoiceNumber = `INV-${order.name.replace(/[^a-zA-Z0-9]/g, '')}`
      const orderDateText = new Date(order.createdAt).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: '2-digit'
      })
      const stateCode = toStateCode(billAddress?.province)
      const placeOfSupply = `${billAddress?.city ?? '-'}${billAddress?.province ? ` (${billAddress.province})` : ''}`
      const fullAddress = [
        billAddress?.address1 ?? '',
        billAddress?.address2 ?? '',
        billAddress?.city ?? '',
        billAddress?.province ?? '',
        billAddress?.zip ?? '',
        billAddress?.country ?? ''
      ]
        .filter((part) => part.trim().length > 0)
        .join(', ')
      const trackingCarrier = order.fulfillmentCarrier ?? order.bestRateCarrier ?? 'Amazon Shipping'
      const trackingNumber = order.fulfillmentTrackingNumber ?? '-'

      const itemsMarkup = rows
        .map((row) => {
          const taxableValue = row.lineTotal / (1 + rate)
          const taxAmount = row.lineTotal - taxableValue
          const hsnCode = '3926'
          return `
            <tr>
              <td class="item-name">${escapeHtml(row.title)}</td>
              <td class="text-center">x${row.qty}</td>
              <td class="text-right">${formatMoney(row.unit, order.currencyCode)}</td>
              <td class="text-center">${hsnCode}</td>
              <td class="text-right">${formatMoney(taxableValue, order.currencyCode)}</td>
              <td class="text-center">${company.defaultTaxRatePercent}%</td>
              <td class="text-right">${formatMoney(taxAmount, order.currencyCode)}</td>
              <td class="text-right">${formatMoney(0, order.currencyCode)}</td>
              <td class="text-right">${formatMoney(row.lineTotal, order.currencyCode)}</td>
            </tr>
          `
        })
        .join('')

      const qrData = encodeURIComponent(`Invoice:${invoiceNumber}|Order:${order.name}`)

      return `
        <section class="invoice ${orderIndex < sourceOrders.length - 1 ? 'page-break' : ''}">
          <div class="invoice-header">
            <div class="cell seller-info">
              <div class="seller-logo-box">LOGO</div>
              <p><strong>${escapeHtml(company.legalName)}</strong></p>
              <p>${escapeHtml(company.addressLine1)}</p>
              <p>${escapeHtml(company.addressLine2 ?? '')}</p>
              <p>${escapeHtml(`${company.city}, ${company.state}, ${company.postalCode}, ${company.country}`)}</p>
              <p><strong>Phone:</strong> ${escapeHtml(company.phone)}</p>
              <p><strong>Email:</strong> ${escapeHtml(company.email)}</p>
              <p><strong>GSTIN:</strong> ${escapeHtml(company.gstin || '-')}</p>
              <p><strong>VAT:</strong> ${escapeHtml(company.vat ?? '')}</p>
              <p><strong>FSSAI:</strong> ${escapeHtml(company.fssai ?? '')}</p>
            </div>

            <div class="cell">
              <div class="invoice-title">TAX INVOICE</div>
              <div class="field-row">
                <div class="field-label">Invoice No.</div>
                <div class="field-value">${escapeHtml(invoiceNumber)}</div>
              </div>
              <div class="field-row">
                <div class="field-label">Order Date</div>
                <div class="field-value">${escapeHtml(orderDateText)}</div>
              </div>
              <div class="barcode"></div>
              <div class="field-row">
                <div class="field-label">Order No.</div>
                <div class="field-value">${escapeHtml(order.name)}</div>
              </div>
            </div>

            <div class="cell">
              <div class="field-row">
                <div class="field-label">Mode of Transport</div>
                <div class="field-value">Standard</div>
              </div>
              <div class="field-row">
                <div class="field-label">Date of Supply</div>
                <div class="field-value">${escapeHtml(orderDateText)}</div>
              </div>
              <div class="field-row">
                <div class="field-label">Place of Supply</div>
                <div class="field-value">${escapeHtml(placeOfSupply)}</div>
              </div>
              <div class="field-row">
                <div class="field-label">State Code</div>
                <div class="field-value">${escapeHtml(stateCode)}</div>
              </div>
              <div class="barcode"></div>
              <div class="field-row">
                <div class="field-label">Tracking Company</div>
                <div class="field-value">${escapeHtml(trackingCarrier)}</div>
              </div>
              <div class="field-row">
                <div class="field-label">Tracking Number</div>
                <div class="field-value">${escapeHtml(trackingNumber)}</div>
              </div>
            </div>

            <div class="cell qr-box">
              <strong>QR Code:</strong>
              <br /><br />
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${qrData}" alt="QR Code" />
            </div>
          </div>

          <div class="note-row">
            <div>
              <div class="note-title">Note</div>
              <div class="cell">Tax payable under Reverse Charge: <strong>No</strong></div>
            </div>
            <div>
              <div class="note-title">Original / Copy</div>
              <div class="cell">Original</div>
            </div>
          </div>

          <div class="address-section">
            <div class="address-box">
              <div class="section-heading">Bill to</div>
              <p><strong>${escapeHtml(billAddress?.name ?? 'Customer')}</strong></p>
              <p>${escapeHtml(fullAddress)}</p>
              <p>State Code ${escapeHtml(stateCode)}</p>
              <p>Phone: ${escapeHtml(billAddress?.phone ?? '-')}</p>
              <p>Email: -</p>
            </div>
            <div class="address-box">
              <div class="section-heading">Ship to</div>
              <p><strong>${escapeHtml(billAddress?.name ?? 'Customer')}</strong></p>
              <p>${escapeHtml(fullAddress)}</p>
              <p>State Code ${escapeHtml(stateCode)}</p>
              <p>Phone: ${escapeHtml(billAddress?.phone ?? '-')}</p>
              <p>Email: -</p>
            </div>
          </div>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width: 30%">Item Description</th>
                <th style="width: 6%">Qty</th>
                <th style="width: 10%">Unit Price</th>
                <th style="width: 8%">HS Code</th>
                <th style="width: 11%">Taxable Value</th>
                <th style="width: 7%">GST %</th>
                <th style="width: 9%">IGST</th>
                <th style="width: 8%">Discount</th>
                <th style="width: 11%">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemsMarkup}
            </tbody>
          </table>

          <div class="bottom-section">
            <div class="bottom-left">
              <table class="gst-table">
                <thead>
                  <tr>
                    <th rowspan="2">HSN</th>
                    <th colspan="2">CGST</th>
                    <th colspan="2">SGST</th>
                    <th colspan="2">IGST</th>
                  </tr>
                  <tr>
                    <th>Rate</th><th>Amount</th>
                    <th>Rate</th><th>Amount</th>
                    <th>Rate</th><th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>3926</td>
                    <td>${isIntraState ? `${company.defaultTaxRatePercent / 2}%` : '0%'}</td>
                    <td>${formatMoney(cgstAmount, order.currencyCode)}</td>
                    <td>${isIntraState ? `${company.defaultTaxRatePercent / 2}%` : '0%'}</td>
                    <td>${formatMoney(sgstAmount, order.currencyCode)}</td>
                    <td>${isIntraState ? '0%' : `${company.defaultTaxRatePercent}%`}</td>
                    <td>${formatMoney(igstAmount, order.currencyCode)}</td>
                  </tr>
                </tbody>
              </table>

              <div class="order-note">
                <strong>Order Note</strong>
                <p><strong>Payment Gateways:</strong> ${escapeHtml(defaultPaymentGateway)}</p>
                <p>Thank you for your purchase!</p>
                <strong>Total</strong>
                <p>${escapeHtml(toWordsSimple(grandTotal))}</p>
              </div>
            </div>

            <div>
              <table class="amount-summary">
                <tr><td>Discount</td><td class="text-right">${formatMoney(discountAmount, order.currencyCode)}</td></tr>
                <tr><td>Total Before Tax</td><td class="text-right">${formatMoney(totalBeforeTax, order.currencyCode)}</td></tr>
                <tr><td>Total Tax</td><td class="text-right">${formatMoney(totalTax, order.currencyCode)}</td></tr>
                <tr><td>Total After Tax</td><td class="text-right">${formatMoney(totalAfterTax, order.currencyCode)}</td></tr>
                <tr><td>Shipping Amount</td><td class="text-right">${formatMoney(shippingAmount, order.currencyCode)}</td></tr>
                <tr><td>Shipping Tax</td><td class="text-right">${formatMoney(shippingTax, order.currencyCode)}</td></tr>
                <tr><td>Shipping Total</td><td class="text-right">${formatMoney(shippingTotal, order.currencyCode)}</td></tr>
                <tr><td>Total Refunded</td><td class="text-right">${formatMoney(totalRefunded, order.currencyCode)}</td></tr>
                <tr><td>Total Outstanding</td><td class="text-right">${formatMoney(totalOutstanding, order.currencyCode)}</td></tr>
                <tr class="grand-total"><td>Grand Total</td><td class="text-right">${formatMoney(grandTotal, order.currencyCode)}</td></tr>
              </table>

              <div class="payment-status">${order.paymentPending ? 'PENDING' : 'PAID'}</div>
            </div>
          </div>
        </section>
      `
    })
    .join('')

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>GST Invoice</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 20px; background: #f3f3f3; font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; }
          .invoice { width: 210mm; min-height: 297mm; margin: auto; background: white; padding: 10mm; }
          .page-break { page-break-after: always; }
          .cell { border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 6px; }
          .cell:last-child { border-right: none; }
          .invoice-header { display: grid; grid-template-columns: 1.3fr 1.5fr 1.3fr 0.8fr; border: 1px solid #222; }
          .seller-info { min-height: 240px; }
          .seller-logo-box { width: 100px; height: 60px; border: 1px dashed #222; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; font-weight: 700; }
          .invoice-title { text-align: center; font-weight: bold; font-size: 16px; margin-bottom: 10px; }
          .field-row { display: grid; grid-template-columns: 1fr 1.2fr; border-bottom: 1px solid #222; }
          .field-row:last-child { border-bottom: none; }
          .field-label { font-weight: bold; padding: 5px; border-right: 1px solid #222; }
          .field-value { padding: 5px; word-break: break-word; }
          .barcode { height: 45px; margin: 8px; background: repeating-linear-gradient(90deg, #111 0px, #111 2px, transparent 2px, transparent 4px, #111 4px, #111 7px, transparent 7px, transparent 9px); }
          .qr-box { text-align: center; padding-top: 5px; }
          .qr-box img { width: 110px; height: 110px; object-fit: contain; }
          .note-row { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #222; border-top: none; }
          .note-title { font-weight: bold; padding: 5px; border-bottom: 1px solid #222; }
          .address-section { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #222; border-top: none; }
          .address-box { min-height: 165px; padding: 8px; }
          .address-box:first-child { border-right: 1px solid #222; }
          .section-heading { font-weight: bold; font-size: 13px; border-bottom: 1px solid #222; padding-bottom: 5px; margin-bottom: 8px; }
          .address-box p { margin: 4px 0; line-height: 1.4; }
          table { width: 100%; border-collapse: collapse; }
          .items-table th, .items-table td { border: 1px solid #222; padding: 6px; vertical-align: top; }
          .items-table th { text-align: left; font-weight: bold; white-space: nowrap; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          .item-name { line-height: 1.5; font-weight: 500; }
          .bottom-section { display: grid; grid-template-columns: 55% 45%; border: 1px solid #222; border-top: none; }
          .bottom-left { border-right: 1px solid #222; }
          .gst-table th, .gst-table td { border: 1px solid #222; padding: 5px; }
          .order-note { padding: 10px; min-height: 120px; border-top: 1px solid #222; }
          .order-note p { margin: 8px 0; }
          .amount-summary { width: 100%; border-collapse: collapse; }
          .amount-summary td { padding: 6px 8px; border-bottom: 1px solid #222; }
          .amount-summary tr:last-child td { border-bottom: none; }
          .grand-total { font-weight: bold; font-size: 14px; }
          .payment-status { text-align: center; font-weight: bold; font-size: 18px; padding: 10px; border-top: 1px solid #222; }
          @media print {
            body { padding: 0; background: white; }
            .invoice { width: 210mm; min-height: 297mm; padding: 8mm; margin: 0; }
            @page { size: A4; margin: 0; }
          }
        </style>
      </head>
      <body>
        ${pages}
        <script>window.print();</script>
      </body>
    </html>
  `
}

function readMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const candidate = payload as { message?: unknown }
  return typeof candidate.message === 'string' ? candidate.message : null
}

function readApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const message = readMessage(payload)
  const details = (payload as { details?: unknown }).details
  if (!Array.isArray(details) || details.length === 0) {
    return message
  }

  const first = details[0]
  if (typeof first !== 'string' || first.trim().length === 0) {
    return message
  }

  let detailText = first
  try {
    const parsed = JSON.parse(first) as { errors?: Array<{ details?: string; message?: string }> }
    const apiDetail = parsed.errors?.[0]?.details ?? parsed.errors?.[0]?.message
    if (typeof apiDetail === 'string' && apiDetail.trim().length > 0) {
      detailText = apiDetail
    }
  } catch {
    // Keep original detail text when JSON parsing is not applicable.
  }

  return message ? `${message} ${detailText}` : detailText
}

function ApiToast({ error, success }: { error: string | null; success: string | null }) {
  const [visibleError, setVisibleError] = useState(error)
  const [visibleSuccess, setVisibleSuccess] = useState(success)

  useEffect(() => {
    setVisibleError(error)
    if (!error) return
    const timer = window.setTimeout(() => setVisibleError(null), 8000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    setVisibleSuccess(success)
    if (!success) return
    const timer = window.setTimeout(() => setVisibleSuccess(null), 5000)
    return () => window.clearTimeout(timer)
  }, [success])

  const message = visibleError ?? visibleSuccess
  return message ? <div className={`api-toast ${visibleError ? 'error' : 'success'}`}>{message}</div> : null
}

const FILTERS: OrderFilter[] = ['all', 'open', 'fulfilled']

const FILTER_TITLES: Record<OrderFilter, string> = {
  all: 'All Orders',
  open: 'Open Orders',
  fulfilled: 'Fulfilled Orders'
}

function getLegacyOrderId(shopifyGid: string): string {
  return shopifyGid.split('/').pop() ?? shopifyGid
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
  PARTIALLY_FULFILLED: 'Partially Fulfilled',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  SCHEDULED: 'Scheduled',
  PENDING_FULFILLMENT: 'Pending',
  RESTOCKED: 'Restocked',
  UNFULFILLED: 'Unfulfilled'
}

function getOrderStatusMeta(fulfillmentStatus: string): { label: string; className: string } {
  const normalized = fulfillmentStatus?.toUpperCase() ?? 'UNFULFILLED'

  if (normalized === 'FULFILLED') {
    return { label: 'Fulfilled', className: 'fulfilled' }
  }
  if (normalized === 'CANCELLED' || normalized === 'RESTOCKED') {
    return { label: ORDER_STATUS_LABELS[normalized], className: 'cancelled' }
  }

  const label =
    ORDER_STATUS_LABELS[normalized] ??
    normalized
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')

  return { label, className: 'processing' }
}

function toEpochMs(value: string | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

function selectBestRateOption(rates: ShippingRateOption[]): ShippingRateOption | null {
  const eligible = rates.filter((rate) => !rate.requiresAdditionalInputs)
  if (eligible.length === 0) {
    return null
  }

  const ranked = [...eligible].sort((a, b) => {
    const aStart = toEpochMs(a.deliveryWindowStart)
    const bStart = toEpochMs(b.deliveryWindowStart)
    if (aStart !== bStart) {
      return aStart - bStart
    }

    const aEnd = toEpochMs(a.deliveryWindowEnd)
    const bEnd = toEpochMs(b.deliveryWindowEnd)
    if (aEnd !== bEnd) {
      return aEnd - bEnd
    }

    return a.amount - b.amount
  })

  return ranked[0]
}

function DashboardPage() {
  const navigate = useNavigate()
  const [activeFilter, setActiveFilter] = useState<OrderFilter>('all')
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [totalOrders, setTotalOrders] = useState(0)
  const [shippingMode, setShippingMode] = useState<'mock' | 'sandbox' | 'live'>('mock')
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [showFullSyncPanel, setShowFullSyncPanel] = useState(false)
  const [fullSyncDateFrom, setFullSyncDateFrom] = useState('')
  const [fullSyncDateTo, setFullSyncDateTo] = useState('')
  const [fullSyncing, setFullSyncing] = useState(false)
  const [batching, setBatching] = useState(false)
  const [loadingRates, setLoadingRates] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<'all' | 'rated' | 'unrated'>('all')
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'cod' | 'prepaid'>('all')
  const [cityFilter, setCityFilter] = useState<string>('all')
  const [dateFromFilter, setDateFromFilter] = useState('')
  const [dateToFilter, setDateToFilter] = useState('')
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])
  const [ratePreview, setRatePreview] = useState<OrderRatesPreview[] | null>(null)
  const [selectedRateByOrderId, setSelectedRateByOrderId] = useState<Record<string, string>>({})
  const [batchResult, setBatchResult] = useState<FulfillmentBatchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showManualOrderForm, setShowManualOrderForm] = useState(false)
  const [manualPackageProfiles, setManualPackageProfiles] = useState<PackageProfile[]>([])
  const [savingManualOrder, setSavingManualOrder] = useState(false)
  const [manualOrder, setManualOrder] = useState<ManualOrderForm>({
    firstName: '', lastName: '', email: '', phone: '', address1: '', address2: '',
    city: '', province: '', zip: '', country: 'India',
    lineItems: [{ title: '', quantity: '1', unitPrice: '' }], paymentPending: true,
    packageProfileId: '', useCustomPackage: false, customPackageName: '',
    customLengthCm: '', customWidthCm: '', customHeightCm: '', customWeightKg: ''
  })

  const openManualOrderForm = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch('/api/settings/packaging')
      const payload = (await response.json()) as PackagingSettingsResponse & { message?: string }
      if (!response.ok) throw new Error(payload.message ?? 'Failed to load package profiles.')
      setManualPackageProfiles(payload.profiles)
      setManualOrder((current) => ({ ...current, packageProfileId: current.packageProfileId || payload.defaultPackage.id || '' }))
      setShowManualOrderForm(true)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to open manual order form.')
    }
  }, [])

  const createManualOrder = useCallback(async () => {
    setSavingManualOrder(true)
    setError(null)
    try {
      const response = await fetch('/api/orders/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: { firstName: manualOrder.firstName, lastName: manualOrder.lastName, email: manualOrder.email, phone: manualOrder.phone },
          shippingAddress: { address1: manualOrder.address1, address2: manualOrder.address2, city: manualOrder.city, province: manualOrder.province, zip: manualOrder.zip, country: manualOrder.country },
          lineItems: manualOrder.lineItems.map((item) => ({ title: item.title, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })),
          paymentPending: manualOrder.paymentPending,
          packageProfileId: manualOrder.useCustomPackage ? undefined : manualOrder.packageProfileId,
          customPackage: manualOrder.useCustomPackage ? {
            name: manualOrder.customPackageName,
            lengthCm: Number(manualOrder.customLengthCm),
            widthCm: Number(manualOrder.customWidthCm),
            heightCm: Number(manualOrder.customHeightCm),
            weightKg: Number(manualOrder.customWeightKg)
          } : undefined
        })
      })
      const payload = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !payload.order) throw new Error(payload.message ?? 'Failed to create manual order.')
      setShowManualOrderForm(false)
      setOrders((current) => [payload.order!, ...current])
      setTotalOrders((current) => current + 1)
      setSuccess(`${payload.order.name} created and rates stored.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to create manual order.')
    } finally {
      setSavingManualOrder(false)
    }
  }, [manualOrder])

  const loadOrders = useCallback(async (filter: OrderFilter) => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/orders?status=${filter}`)
      const data = (await response.json()) as OrdersResponse

      if (!response.ok) {
        throw new Error(readMessage(data) ?? 'Failed to fetch orders.')
      }

      setOrders(data.orders)
      setTotalOrders(data.totalOrders)
      setShippingMode(data.shippingMode ?? 'mock')
      setLastSyncedAt(data.lastSyncedAt)
      setSelectedOrderIds([])
      setRatePreview(null)
      setSelectedRateByOrderId({})
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Unknown error while loading orders.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  const syncOrders = useCallback(async () => {
    setSyncing(true)
    setError(null)

    try {
      const response = await fetch('/api/orders/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ limit: 100 })
      })
      const data = (await response.json()) as SyncResponse

      if (!response.ok) {
        throw new Error(readMessage(data) ?? 'Failed to sync orders.')
      }

      setLastSyncedAt(data.lastSyncedAt)
      setTotalOrders(data.totalOrders)
      await loadOrders(activeFilter)
      setSuccess('Orders synced and rates refreshed.')
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Unknown error while syncing orders.'
      setError(message)
    } finally {
      setSyncing(false)
    }
  }, [activeFilter, loadOrders])

  const runFullSync = useCallback(async (options: { dateFrom?: string; dateTo?: string }) => {
    setFullSyncing(true)
    setError(null)

    try {
      const hasRange = Boolean(options.dateFrom || options.dateTo)
      const response = await fetch('/api/orders/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(
          hasRange
            ? { dateFrom: options.dateFrom || undefined, dateTo: options.dateTo || undefined }
            : { fullSync: true }
        )
      })
      const data = (await response.json()) as SyncResponse

      if (!response.ok) {
        throw new Error(readMessage(data) ?? 'Failed to sync orders.')
      }

      setLastSyncedAt(data.lastSyncedAt)
      setTotalOrders(data.totalOrders)
      await loadOrders(activeFilter)
      setShowFullSyncPanel(false)
      setSuccess(
        hasRange
          ? `Synced orders from ${options.dateFrom || 'the beginning'} to ${options.dateTo || 'now'}.`
          : 'Synced all orders from Shopify.'
      )
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Unknown error while syncing orders.'
      setError(message)
    } finally {
      setFullSyncing(false)
    }
  }, [activeFilter, loadOrders])

  const toggleOrderSelection = (orderId: string) => {
    setSelectedOrderIds((current) =>
      current.includes(orderId)
        ? current.filter((value) => value !== orderId)
        : [...current, orderId]
    )
  }

  const cityOptions = useMemo(() => {
    const values = new Set<string>()
    for (const order of orders) {
      const city = order.shippingAddress?.city?.trim()
      if (city) {
        values.add(city)
      }
    }

    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [orders])

  const filteredOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const fromMs = dateFromFilter ? Date.parse(`${dateFromFilter}T00:00:00`) : null
    const toMs = dateToFilter ? Date.parse(`${dateToFilter}T23:59:59.999`) : null

    return orders.filter((order) => {
      const orderMs = Date.parse(order.createdAt)
      if (fromMs !== null && Number.isFinite(fromMs) && Number.isFinite(orderMs) && orderMs < fromMs) {
        return false
      }

      if (toMs !== null && Number.isFinite(toMs) && Number.isFinite(orderMs) && orderMs > toMs) {
        return false
      }

      if (paymentFilter === 'cod' && !order.paymentPending) {
        return false
      }

      if (paymentFilter === 'prepaid' && order.paymentPending) {
        return false
      }

      if (carrierFilter === 'rated' && typeof order.bestRateAmount !== 'number') {
        return false
      }

      if (carrierFilter === 'unrated' && typeof order.bestRateAmount === 'number') {
        return false
      }

      if (cityFilter !== 'all' && (order.shippingAddress?.city ?? '').trim() !== cityFilter) {
        return false
      }

      if (!query) {
        return true
      }

      const legacyId = getLegacyOrderId(order.id)
      const haystack = [
        order.name,
        legacyId,
        order.shippingAddress?.name,
        order.shippingAddress?.phone,
        order.shippingAddress?.city,
        order.shippingAddress?.zip,
        order.bestRateCarrier,
        order.bestRateService
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(query)
    })
  }, [carrierFilter, cityFilter, dateFromFilter, dateToFilter, orders, paymentFilter, searchQuery])

  const allVisibleSelected = useMemo(() => {
    const visibleIds = filteredOrders.map((order) => order.id)
    if (visibleIds.length === 0) {
      return false
    }

    return visibleIds.every((id) => selectedOrderIds.includes(id))
  }, [filteredOrders, selectedOrderIds])

  const toggleSelectAllVisible = () => {
    const visibleIds = filteredOrders.map((order) => order.id)
    if (visibleIds.length === 0) {
      return
    }

    if (allVisibleSelected) {
      setSelectedOrderIds((current) => current.filter((id) => !visibleIds.includes(id)))
      return
    }

    setSelectedOrderIds((current) => {
      const merged = new Set(current)
      for (const id of visibleIds) {
        merged.add(id)
      }

      return Array.from(merged)
    })
  }

  const submitBatch = useCallback(async (selectedRates?: Record<string, string>) => {
    setBatching(true)
    setError(null)

    try {
      const response = await fetch('/api/fulfillment/batches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          orderIds: selectedOrderIds,
          dryRun: false,
          selectedRatesByOrderId: selectedRates
        })
      })

      const data = (await response.json()) as FulfillmentBatchResponse

      if (!response.ok) {
        throw new Error(readMessage(data) ?? 'Failed to generate batch labels.')
      }

      setBatchResult(data)
      setSelectedOrderIds([])
      setRatePreview(null)
      setSelectedRateByOrderId({})
      setSuccess(`Batch completed: ${data.batch.successCount} label(s) generated.`)
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while generating batch labels.'
      setError(message)
    } finally {
      setBatching(false)
    }
  }, [selectedOrderIds])

  const createBatchLabels = useCallback(async () => {
    if (selectedOrderIds.length === 0) {
      setError('Select at least one order for batch label generation.')
      return
    }

    setLoadingRates(true)
    setError(null)

    try {
      const response = await fetch('/api/fulfillment/rates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          orderIds: selectedOrderIds
        })
      })

      const data = (await response.json()) as FulfillmentRatesResponse
      if (!response.ok) {
        throw new Error(readMessage(data) ?? 'Failed to fetch shipping rates.')
      }

      const defaults: Record<string, string> = {}
      for (const entry of data.rates) {
        const bestRate = selectBestRateOption(entry.rates)
        if (bestRate) {
          defaults[entry.orderId] = bestRate.rateId
        }
      }

      setRatePreview(data.rates)
      setSelectedRateByOrderId(defaults)
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while fetching rates.'
      setError(message)
    } finally {
      setLoadingRates(false)
    }
  }, [selectedOrderIds, submitBatch])

  const confirmRatesAndGenerate = useCallback(async () => {
    if (!ratePreview || ratePreview.length === 0) {
      setError('No rates available to generate labels.')
      return
    }

    const missingSelections = ratePreview.some((entry) => !selectedRateByOrderId[entry.orderId])
    if (missingSelections) {
      setError('Choose a rate for each selected order before generating labels.')
      return
    }

    await submitBatch(selectedRateByOrderId)
  }, [ratePreview, selectedRateByOrderId, submitBatch])

  useEffect(() => {
    void loadOrders(activeFilter)
  }, [activeFilter, loadOrders])

  const printOrdersInvoice = useCallback((sourceOrders: OrderSummary[]) => {
    if (sourceOrders.length === 0) {
      setError('No orders selected for invoice printing.')
      return
    }

    const html = buildInvoiceHtml(sourceOrders, HARD_CODED_INVOICE_COMPANY)
    const printWindow = window.open('', '_blank', 'width=1000,height=900')
    if (!printWindow) {
      setError('Unable to open print window. Please allow popups for this site.')
      return
    }

    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
  }, [])

  const printSelectedInvoices = useCallback(() => {
    const selectedOrders = orders.filter((order) => selectedOrderIds.includes(order.id))
    printOrdersInvoice(selectedOrders)
  }, [orders, printOrdersInvoice, selectedOrderIds])

  const openAllBatchLabels = useCallback(() => {
    const labelJobs = (batchResult?.jobs ?? []).filter(
      (job) => job.status === 'SUCCESS' && Boolean(job.labelUrl)
    )

    if (labelJobs.length === 0) {
      setError('No generated labels are available in this batch.')
      return
    }

    const popup = window.open('', '_blank', 'width=1200,height=900')
    if (!popup) {
      setError('Unable to open labels window. Please allow popups for this site.')
      return
    }

    const cards = labelJobs
      .map((job) => {
        const labelUrl = toAbsoluteLabelUrl(job.labelUrl!)
        const orderRef = escapeHtml(getLegacyOrderId(job.orderId))
        const tracking = escapeHtml(job.trackingNumber ?? '-')
        const safeUrl = escapeHtml(labelUrl)

        return `
          <article class="label-card">
            <header>
              <h2>Order ${orderRef}</h2>
              <p>Tracking: ${tracking}</p>
            </header>
            <iframe src="${safeUrl}" title="label-${orderRef}"></iframe>
            <div class="actions">
              <a href="${safeUrl}" target="_blank" rel="noreferrer">Open</a>
              <a href="${safeUrl}" target="_blank" rel="noreferrer" download>Download</a>
            </div>
          </article>
        `
      })
      .join('')

    popup.document.open()
    popup.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Batch Labels</title>
          <style>
            body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
            .wrap { max-width: 1180px; margin: 0 auto; padding: 20px; }
            h1 { margin: 0 0 12px; }
            .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
            .label-card { background: #fff; border: 1px solid #dbe3ee; border-radius: 12px; overflow: hidden; }
            .label-card header { padding: 12px 14px 4px; }
            .label-card h2 { margin: 0; font-size: 16px; }
            .label-card p { margin: 6px 0 0; color: #475569; font-size: 13px; }
            .label-card iframe { width: 100%; height: 560px; border: 0; background: #fff; }
            .actions { display: flex; gap: 10px; padding: 10px 14px 14px; }
            .actions a { text-decoration: none; border: 1px solid #fb923c; background: #fff7ed; color: #9a3412; border-radius: 999px; padding: 8px 12px; font-weight: 700; font-size: 13px; }
          </style>
        </head>
        <body>
          <main class="wrap">
            <h1>Batch Labels (${labelJobs.length})</h1>
            <section class="grid">${cards}</section>
          </main>
        </body>
      </html>
    `)
    popup.document.close()
  }, [batchResult])

  const subtitle = useMemo(() => {
    if (!lastSyncedAt) {
      return 'Never synced'
    }

    return `Last synced: ${new Date(lastSyncedAt).toLocaleString()}`
  }, [lastSyncedAt])

  const filterCountLabel = `${FILTER_TITLES[activeFilter]} (${orders.length})`
  const visibleCountLabel = `Visible ${filteredOrders.length} of ${orders.length}`

  const formatOrderDate = (value: string): string => {
    return new Date(value).toLocaleDateString('en-CA')
  }

  const toShipTo = (address: ShippingAddress | null): string => {
    if (!address) {
      return '-'
    }

    const city = address.city ?? '-'
    const state = address.province ?? '-'
    const zip = address.zip ?? '-'
    return `${city}, ${state}, ${zip}`
  }

  const toOrderCustomer = (address: ShippingAddress | null): string => {
    return address?.name?.trim() || '-'
  }

  return (
    <main className="dashboard ops-page">
      <section className="ops-topbar">
        <div>
          <p className="eyebrow">Orders</p>
          <h1>Order Operations</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <div className="ops-top-actions">
          <span className="ops-mode-chip">Total: {totalOrders}</span>
          <span className="ops-mode-chip">Mode: {shippingMode.toUpperCase()}</span>
          <button className="filter-button" onClick={() => navigate('/settings')}>
            Settings
          </button>
          <button className="filter-button" onClick={() => navigate('/labels')}>
            Labels
          </button>
          <button className="filter-button" onClick={() => void loadOrders(activeFilter)}>
            Refresh
          </button>
          <button className="filter-button" onClick={() => void openManualOrderForm()}>
            Add Order
          </button>
          <button className="sync-button" disabled={syncing} onClick={() => void syncOrders()}>
            {syncing ? 'Syncing...' : 'Import Orders'}
          </button>
          <div className="full-sync-control">
            <button
              className="filter-button"
              onClick={() => setShowFullSyncPanel((current) => !current)}
            >
              Full Sync
            </button>
            {showFullSyncPanel ? (
              <div className="full-sync-panel">
                <label>
                  From
                  <input
                    type="date"
                    value={fullSyncDateFrom}
                    onChange={(event) => setFullSyncDateFrom(event.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={fullSyncDateTo}
                    onChange={(event) => setFullSyncDateTo(event.target.value)}
                  />
                </label>
                <button
                  className="sync-button"
                  disabled={fullSyncing || (!fullSyncDateFrom && !fullSyncDateTo)}
                  onClick={() => void runFullSync({ dateFrom: fullSyncDateFrom, dateTo: fullSyncDateTo })}
                >
                  {fullSyncing ? 'Syncing...' : 'Sync Date Range'}
                </button>
                <button
                  className="filter-button"
                  disabled={fullSyncing}
                  onClick={() => void runFullSync({})}
                >
                  {fullSyncing ? 'Syncing...' : 'Sync All Orders'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="ops-shell">
        <div className="ops-tabs" role="tablist" aria-label="Order filters">
          {FILTERS.map((filter) => {
            const isActive = filter === activeFilter
            const label = filter === 'all' ? 'All' : filter === 'open' ? 'Open' : 'Fulfilled'
            return (
              <button
                key={filter}
                className={`ops-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActiveFilter(filter)}
                role="tab"
                aria-selected={isActive}
              >
                {label}
              </button>
            )
          })}
          <span className="ops-total-count">{filterCountLabel}</span>
        </div>

        <div className="ops-filters-row">
          <input
            className="ops-search-input"
            type="search"
            placeholder="Search by order, customer, phone, city, carrier"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <select
            className="ops-select"
            value={carrierFilter}
            onChange={(event) => setCarrierFilter(event.target.value as 'all' | 'rated' | 'unrated')}
          >
            <option value="all">All Carriers</option>
            <option value="rated">With Best Rate</option>
            <option value="unrated">Without Best Rate</option>
          </select>
          <select
            className="ops-select"
            value={paymentFilter}
            onChange={(event) => setPaymentFilter(event.target.value as 'all' | 'cod' | 'prepaid')}
          >
            <option value="all">All Payments</option>
            <option value="cod">COD</option>
            <option value="prepaid">Prepaid</option>
          </select>
          <select
            className="ops-select"
            value={cityFilter}
            onChange={(event) => setCityFilter(event.target.value)}
          >
            <option value="all">All Cities</option>
            {cityOptions.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
          </select>
          <input
            className="ops-date-input"
            type="date"
            value={dateFromFilter}
            onChange={(event) => setDateFromFilter(event.target.value)}
            aria-label="Created from date"
          />
          <input
            className="ops-date-input"
            type="date"
            value={dateToFilter}
            onChange={(event) => setDateToFilter(event.target.value)}
            aria-label="Created to date"
          />
          <span className="ops-total-count">{visibleCountLabel}</span>
          <button className="filter-button" onClick={toggleSelectAllVisible}>
            {allVisibleSelected
              ? 'Unselect All'
              : 'Select All Visible'}
          </button>
          <button
            className="filter-button"
            disabled={selectedOrderIds.length === 0}
            onClick={printSelectedInvoices}
          >
            Print GST Invoices ({selectedOrderIds.length})
          </button>
          <button
            className="sync-button"
            disabled={batching || loadingRates || selectedOrderIds.length === 0}
            onClick={() => void createBatchLabels()}
          >
            {batching || loadingRates
              ? 'Generating...'
              : `Generate Labels (${selectedOrderIds.length})`}
          </button>
        </div>
      </section>

      {shippingMode === 'mock' ? (
        <p className="error-banner">
          Running in MOCK mode. Label generation returns test URLs, not sandbox PDF label payloads.
        </p>
      ) : null}

      {ratePreview ? (
        <section className="rate-picker">
          <h3>Choose Shipping Rates</h3>
          <p className="muted">Select one rate per order, then confirm label generation.</p>
          <div className="rate-picker-list">
            {ratePreview.map((entry) => (
              <article key={entry.orderId} className="rate-picker-item">
                <p>
                  <strong>{entry.orderName}</strong> ({entry.orderId.split('/').pop()})
                </p>
                <select
                  value={selectedRateByOrderId[entry.orderId] ?? ''}
                  onChange={(event) =>
                    setSelectedRateByOrderId((current) => ({
                      ...current,
                      [entry.orderId]: event.target.value
                    }))
                  }
                >
                  <option value="" disabled>
                    Select a rate
                  </option>
                  {entry.rates.map((rate) => (
                    <option
                      key={rate.rateId}
                      value={rate.rateId}
                      disabled={rate.requiresAdditionalInputs}
                    >
                      {rate.carrierName} - {rate.serviceName} ({rate.amount} {rate.currencyCode})
                      {rate.requiresAdditionalInputs ? ' [Needs extra inputs]' : ''}
                    </option>
                  ))}
                </select>
              </article>
            ))}
          </div>
          <div className="rate-picker-actions">
            <button className="filter-button" onClick={() => setRatePreview(null)}>
              Cancel
            </button>
            <button className="sync-button" disabled={batching} onClick={() => void confirmRatesAndGenerate()}>
              {batching ? 'Generating...' : 'Confirm & Generate Labels'}
            </button>
          </div>
        </section>
      ) : null}

      {batchResult ? (
        <section className="batch-result">
          <h3>Latest Batch</h3>
          <p className="muted">Batch ID: {batchResult.batch.id}</p>
          <p>
            <strong>Status:</strong> {batchResult.batch.status}
          </p>
          <p>
            <strong>Summary:</strong> success {batchResult.batch.successCount}, failed {batchResult.batch.failedCount}, skipped {batchResult.batch.skippedCount}
          </p>
          <button className="details-link" onClick={openAllBatchLabels}>
            Open All Labels
          </button>
          <ul>
            {batchResult.jobs.map((job) => (
              <li key={job.id}>
                {job.orderId.split('/').pop()} | {job.status}
                {job.trackingNumber ? ` | tracking ${job.trackingNumber}` : ''}
                {job.collectAmount ? ` | collect ${job.collectAmount}` : ''}
                {job.errorMessage ? ` | ${job.errorMessage}` : ''}
                {job.labelUrl ? <LabelPreview labelUrl={job.labelUrl} orderId={job.orderId} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ApiToast error={error} success={success} />

      {loading ? (
        <p className="status">Loading orders...</p>
      ) : filteredOrders.length === 0 ? (
        <p className="status">No orders available for this filter.</p>
      ) : (
        <section className="orders-table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th className="cell-check" />
                <th>Order</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Shipping Cost</th>
                <th>Packages</th>
                <th>Products</th>
                <th>Carrier</th>
                <th>Status</th>
                <th>Total</th>
                <th>Outstanding</th>
                <th>Ship To</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order) => {
                const legacyOrderId = getLegacyOrderId(order.id)
                const outstanding = order.paymentPending ? order.amountToCollect : '0.00'
                const totalMode = order.paymentPending ? 'via cod' : 'via prepaid'
                const rateCurrency = order.bestRateCurrency ?? order.currencyCode
                const shippingCostLabel =
                  typeof order.bestRateAmount === 'number'
                    ? `${rateCurrency} ${order.bestRateAmount.toFixed(2)}`
                    : '--'
                const carrierLabel = order.bestRateCarrier
                  ? `${order.bestRateCarrier}${order.bestRateService ? ` - ${order.bestRateService}` : ''}`
                  : '--'

                return (
                  <tr key={order.id}>
                    <td className="cell-check">
                      <input
                        type="checkbox"
                        checked={selectedOrderIds.includes(order.id)}
                        disabled={order.fulfillmentStatus === 'FULFILLED'}
                        onChange={() => toggleOrderSelection(order.id)}
                        aria-label={`Select ${order.name}`}
                        title={order.fulfillmentStatus === 'FULFILLED' ? 'Order is already fulfilled in Shopify.' : undefined}
                      />
                    </td>
                    <td>
                      <button className="order-link" onClick={() => navigate(`/orders/${legacyOrderId}`)}>
                        {order.name}
                      </button>
                    </td>
                    <td>{formatOrderDate(order.createdAt)}</td>
                    <td>{toOrderCustomer(order.shippingAddress)}</td>
                    <td>{shippingCostLabel}</td>
                    <td>
                      <span className="package-pill">{order.lineItems.length} Package(s)</span>
                    </td>
                    <td>
                      <span className="product-pill">
                        {order.lineItems.length} x {order.lineItems[0]?.title ?? 'Item'}
                      </span>
                    </td>
                    <td>{carrierLabel}</td>
                    <td>
                      <span className={`status-pill ${getOrderStatusMeta(order.fulfillmentStatus).className}`}>
                        {getOrderStatusMeta(order.fulfillmentStatus).label}
                      </span>
                    </td>
                    <td>
                      {order.currencyCode} {order.totalPrice} <span className="inline-subtle">{totalMode}</span>
                    </td>
                    <td>
                      {order.currencyCode} {outstanding}
                    </td>
                    <td>{toShipTo(order.shippingAddress)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="mini-action"
                          onClick={() => navigate(`/orders/${legacyOrderId}`)}
                        >
                          Details
                        </button>
                        <button
                          className="mini-action"
                          onClick={() => printOrdersInvoice([order])}
                        >
                          Invoice
                        </button>
                        {order.fulfillmentLabelUrl ? (
                          <a
                            className="mini-action"
                            href={toAbsoluteLabelUrl(order.fulfillmentLabelUrl)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Label
                          </a>
                        ) : null}
                        {order.fulfillmentTrackingNumber ? (
                          <a
                            className="mini-action"
                            href={toAmazonTrackingUrl(order.fulfillmentTrackingNumber)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Track
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
      {showManualOrderForm ? (
        <section className="details-modal-backdrop" role="dialog" aria-modal="true" aria-label="Add manual order">
          <div className="details-modal-sheet manual-order-modal">
            <div className="details-modal-body">
              <h2>Add Manual Order</h2>
              <div className="settings-form-grid">
                {([['firstName', 'First Name'], ['lastName', 'Last Name'], ['email', 'Email'], ['phone', 'Phone'], ['address1', 'Address Line 1'], ['address2', 'Address Line 2'], ['city', 'City'], ['province', 'State'], ['zip', 'Pincode'], ['country', 'Country']] as Array<[keyof ManualOrderForm, string]>).map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input
                      type={field === 'email' ? 'email' : 'text'}
                      value={manualOrder[field] as string}
                      onChange={(event) => setManualOrder((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
                <label>
                  Payment
                  <select value={manualOrder.paymentPending ? 'COD' : 'PREPAID'} onChange={(event) => setManualOrder((current) => ({ ...current, paymentPending: event.target.value === 'COD' }))}>
                    <option value="COD">COD / Pending</option>
                    <option value="PREPAID">Prepaid / Paid</option>
                  </select>
                </label>
                <label>
                  Package
                  <select value={manualOrder.useCustomPackage ? 'custom' : manualOrder.packageProfileId} onChange={(event) => setManualOrder((current) => ({ ...current, useCustomPackage: event.target.value === 'custom', packageProfileId: event.target.value === 'custom' ? '' : event.target.value }))}>
                    <option value="">Global Default</option>
                    {manualPackageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} ({profile.lengthCm} x {profile.widthCm} x {profile.heightCm} cm)</option>)}
                    <option value="custom">Custom box for this order</option>
                  </select>
                </label>
                {manualOrder.useCustomPackage ? <>
                  {([['customPackageName', 'Box Name'], ['customLengthCm', 'Length (cm)'], ['customWidthCm', 'Width (cm)'], ['customHeightCm', 'Height (cm)'], ['customWeightKg', 'Weight (kg)']] as Array<[keyof ManualOrderForm, string]>).map(([field, label]) => <label key={field}>{label}<input type={field === 'customPackageName' ? 'text' : 'number'} min="0.01" step="0.1" value={manualOrder[field] as string} onChange={(event) => setManualOrder((current) => ({ ...current, [field]: event.target.value }))} /></label>)}
                </> : null}
              </div>
              <h3>Products</h3>
              {manualOrder.lineItems.map((item, index) => <div className="manual-product-row" key={index}>
                <input type="text" placeholder="Product name" value={item.title} onChange={(event) => setManualOrder((current) => ({ ...current, lineItems: current.lineItems.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: event.target.value } : entry) }))} />
                <input type="number" min="1" placeholder="Qty" value={item.quantity} onChange={(event) => setManualOrder((current) => ({ ...current, lineItems: current.lineItems.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: event.target.value } : entry) }))} />
                <input type="number" min="0.01" step="0.01" placeholder="Price (INR)" value={item.unitPrice} onChange={(event) => setManualOrder((current) => ({ ...current, lineItems: current.lineItems.map((entry, itemIndex) => itemIndex === index ? { ...entry, unitPrice: event.target.value } : entry) }))} />
                <button className="mini-action" type="button" disabled={manualOrder.lineItems.length === 1} onClick={() => setManualOrder((current) => ({ ...current, lineItems: current.lineItems.filter((_, itemIndex) => itemIndex !== index) }))}>Remove</button>
              </div>)}
              <button className="filter-button" type="button" onClick={() => setManualOrder((current) => ({ ...current, lineItems: [...current.lineItems, { title: '', quantity: '1', unitPrice: '' }] }))}>Add Product</button>
            </div>
            <div className="details-modal-footer">
              <button className="modal-link-button" type="button" onClick={() => setShowManualOrderForm(false)}>Cancel</button>
              <button className="modal-link-button save" type="button" disabled={savingManualOrder} onClick={() => void createManualOrder()}>{savingManualOrder ? 'Creating...' : 'Create Order'}</button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  )
}

function LabelsPage() {
  const navigate = useNavigate()
  const [groups, setGroups] = useState<LabelGroup[]>([])
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const loadGroups = useCallback(async () => {
    try {
      const response = await fetch('/api/labels/groups')
      const payload = (await response.json()) as { groups?: LabelGroup[]; message?: string }
      if (!response.ok) throw new Error(payload.message ?? 'Failed to load label groups.')
      setGroups(payload.groups ?? [])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load label groups.')
    }
  }, [])

  useEffect(() => { void loadGroups() }, [loadGroups])

  const selectedJobs = groups.flatMap((group) => group.jobs).filter((job) => selectedJobIds.includes(job.id) && job.status === 'SUCCESS' && job.labelUrl)
  const toggleGroup = (group: LabelGroup) => {
    const selectableIds = group.jobs.filter((job) => job.status === 'SUCCESS' && job.labelUrl).map((job) => job.id)
    const alreadySelected = selectableIds.length > 0 && selectableIds.every((id) => selectedJobIds.includes(id))
    setSelectedJobIds((current) => alreadySelected ? current.filter((id) => !selectableIds.includes(id)) : Array.from(new Set([...current, ...selectableIds])))
  }

  const downloadSelected = async () => {
    if (selectedJobs.length === 0) { setError('Select at least one generated label.'); return }
    try {
      const mergedPdf = await PDFDocument.create()
      for (const job of selectedJobs) {
        const response = await fetch(toAbsoluteLabelUrl(job.labelUrl!))
        if (!response.ok) throw new Error(`Failed to download label for ${job.order?.name ?? job.orderId}.`)
        const sourcePdf = await PDFDocument.load(await response.arrayBuffer())
        const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices())
        pages.forEach((page) => mergedPdf.addPage(page))
      }
      const mergedBytes = await mergedPdf.save()
      const blob = new Blob([mergedBytes as unknown as BlobPart], { type: 'application/pdf' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `labels-${new Date().toISOString().slice(0, 10)}.pdf`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(link.href)
      setSuccess(`Downloaded ${selectedJobs.length} label(s) in one PDF.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to merge selected labels.')
    }
  }

  const printSelectedInvoices = () => {
    const orders = selectedJobs.map((job) => job.order).filter((order): order is OrderSummary => Boolean(order))
    if (orders.length === 0) { setError('Select labels with matching orders to print GST invoices.'); return }
    const popup = window.open('', '_blank', 'width=1000,height=900')
    if (!popup) { setError('Unable to open invoice window. Please allow popups.'); return }
    popup.document.write(buildInvoiceHtml(orders, HARD_CODED_INVOICE_COMPANY))
    popup.document.close()
    setSuccess(`Opened ${orders.length} GST invoice(s).`)
  }

  return <main className="dashboard ops-page">
    <section className="ops-topbar">
      <div><p className="eyebrow">Fulfillment</p><h1>Label Batches</h1></div>
      <div className="ops-top-actions">
        <button className="filter-button" onClick={() => navigate(-1)}>Orders</button>
        <button className="filter-button" onClick={() => void loadGroups()}>Refresh</button>
        <button className="filter-button" disabled={selectedJobs.length === 0} onClick={printSelectedInvoices}>GST Invoices</button>
        <button className="sync-button" disabled={selectedJobs.length === 0} onClick={() => void downloadSelected()}>Download Labels</button>
      </div>
    </section>
    <ApiToast error={error} success={success} />
    <section className="orders-table-wrap">
      <table className="orders-table label-groups-table"><tbody>
        {groups.map((group) => {
          const selectableIds = group.jobs.filter((job) => job.status === 'SUCCESS' && job.labelUrl).map((job) => job.id)
          const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedJobIds.includes(id))
          const successfulJobs = group.jobs.filter((job) => job.status === 'SUCCESS' && Boolean(job.labelUrl))
          return <Fragment key={group.id}>
            <tr key={group.id}>
              <td><button className="mini-action" onClick={() => setExpandedGroupId(expandedGroupId === group.id ? null : group.id)}>{expandedGroupId === group.id ? '-' : '+'}</button></td>
              <td><input type="checkbox" checked={allSelected} onChange={() => toggleGroup(group)} /></td>
              <td><strong>{group.groupId}</strong></td><td>{new Date(group.createdAt).toLocaleString()}</td>
              <td>{group.successCount} of {group.totalOrders} successful</td><td>{group.status}</td>
            </tr>
            {expandedGroupId === group.id ? successfulJobs.map((job) => <tr key={job.id} className="label-group-job">
              <td /><td>{job.status === 'SUCCESS' && job.labelUrl ? <input type="checkbox" checked={selectedJobIds.includes(job.id)} onChange={() => setSelectedJobIds((current) => current.includes(job.id) ? current.filter((id) => id !== job.id) : [...current, job.id])} /> : null}</td>
              <td>{job.order?.name ?? job.orderId.split('/').pop()}</td><td>{job.trackingNumber ?? '--'}</td><td>{job.carrier ?? '--'}</td><td>{job.status}</td>
            </tr>) : null}
          </Fragment>
        })}
      </tbody></table>
      {groups.length === 0 ? <p className="status">No label groups created yet.</p> : null}
    </section>
  </main>
}

function OrderDetailsPage() {
  const { legacyId } = useParams<{ legacyId: string }>()
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [defaultPackage, setDefaultPackage] = useState<DefaultPackage | null>(null)
  const [packageProfiles, setPackageProfiles] = useState<PackageProfile[]>([])
  const [orderRates, setOrderRates] = useState<ShippingRateOption[]>([])
  const [selectedRateId, setSelectedRateId] = useState('')
  const [ratesLoading, setRatesLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generatingLabel, setGeneratingLabel] = useState(false)
  const [generationStep, setGenerationStep] = useState<string | null>(null)
  const [shipment, setShipment] = useState<GeneratedShipment | null>(null)
  const [shipmentAlreadyExists, setShipmentAlreadyExists] = useState(false)
  const [editingAddress, setEditingAddress] = useState(false)
  const [savingAddress, setSavingAddress] = useState(false)
  const [savingPackage, setSavingPackage] = useState(false)
  const [savingPaymentStatus, setSavingPaymentStatus] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [selectedPackageProfileId, setSelectedPackageProfileId] = useState('')
  const [selectedPaymentStatus, setSelectedPaymentStatus] = useState<'PENDING' | 'PAID'>('PENDING')
  const [addressForm, setAddressForm] = useState<AddressEditForm>({
    firstName: '',
    lastName: '',
    company: '',
    phone: '',
    email: '',
    address1: '',
    address2: '',
    city: '',
    province: '',
    zip: '',
    country: 'India'
  })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const addressToText = (address: ShippingAddress | null): string => {
    if (!address) {
      return 'No shipping address'
    }

    const parts = [
      address.name,
      address.company,
      address.address1,
      address.address2,
      address.city,
      address.province,
      address.zip,
      address.country
    ].filter(Boolean)

    return parts.length > 0 ? parts.join(', ') : 'No shipping address'
  }

  const formatDate = (value: string): string => {
    return new Date(value).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  }

  const loadDefaultPackage = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/packaging')
      const payload = (await response.json()) as PackagingSettingsResponse & { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to load packaging settings.')
      }

      setDefaultPackage(payload.defaultPackage)
      setPackageProfiles(payload.profiles)
    } catch {
      setDefaultPackage(null)
      setPackageProfiles([])
    }
  }, [])

  const loadOrderRates = useCallback(async (orderId: string) => {
    const orderLegacyId = getLegacyOrderId(orderId)
    setRatesLoading(true)

    try {
      const response = await fetch(`/api/orders/${orderLegacyId}/rates/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const responseText = await response.text()
      let payload: { order?: OrderSummary; rates?: ShippingRateOption[]; message?: string }
      try {
        payload = JSON.parse(responseText) as { order?: OrderSummary; rates?: ShippingRateOption[]; message?: string }
      } catch {
        throw new Error(
          `Rates refresh endpoint returned ${response.status}. Restart the backend to load the latest API routes.`
        )
      }
      if (!response.ok) {
        throw new Error(readApiError(payload) ?? 'Failed to load rates.')
      }

      const rates = payload.rates ?? []
      setOrderRates(rates)
      setOrder(payload.order ?? null)
      setSelectedRateId(selectBestRateOption(rates)?.rateId ?? '')
    } catch (requestError) {
      setOrderRates([])
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while loading shipping rates.'
      setError(message)
    } finally {
      setRatesLoading(false)
    }
  }, [])

  const saveFulfillmentDetails = useCallback(async () => {
    const packageProfileId = selectedPackageProfileId || defaultPackage?.id
    if (!legacyId || !order || !packageProfileId) {
      return
    }

    setSavingPackage(true)
    setSavingPaymentStatus(true)
    setError(null)
    try {
      const response = await fetch(`/api/orders/${legacyId}/fulfillment-details`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageProfileId,
          financialStatus: selectedPaymentStatus
        })
      })
      const payload = (await response.json()) as { order?: OrderSummary; rates?: ShippingRateOption[]; message?: string }
      if (!response.ok || !payload.order) {
        throw new Error(payload.message ?? 'Failed to save order changes.')
      }

      setOrder(payload.order)
      setOrderRates(payload.rates ?? [])
      setSelectedRateId(selectBestRateOption(payload.rates ?? [])?.rateId ?? '')
      setSelectedPackageProfileId(payload.order.packageProfileId ?? packageProfileId)
      setSelectedPaymentStatus(payload.order.paymentPending ? 'PENDING' : 'PAID')
      setSuccess(payload.message ?? 'Order changes saved and rates refreshed.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save order changes.')
    } finally {
      setSavingPackage(false)
      setSavingPaymentStatus(false)
    }
  }, [defaultPackage?.id, legacyId, order, selectedPackageProfileId, selectedPaymentStatus])

  const saveSelectedRate = useCallback(async (rateId: string) => {
    if (!legacyId) return
    setError(null)
    try {
      const response = await fetch(`/api/orders/${legacyId}/rate`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateId })
      })
      const payload = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !payload.order) throw new Error(payload.message ?? 'Failed to save selected rate.')
      setSelectedRateId(rateId)
      setOrder(payload.order)
      setSuccess(payload.message ?? 'Selected shipping rate saved.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save selected rate.')
    }
  }, [legacyId])

  useEffect(() => {
    const loadOrderDetails = async () => {
      if (!legacyId) {
        setError('Invalid order id.')
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`/api/orders/${legacyId}`)
        const payload = (await response.json()) as { order?: OrderSummary; message?: string }

        if (!response.ok) {
          throw new Error(payload.message ?? 'Failed to fetch order details.')
        }

        const nextOrder = payload.order ?? null
        setOrder(nextOrder)
        setSelectedPackageProfileId(nextOrder?.packageProfileId ?? '')
        setSelectedPaymentStatus(nextOrder?.paymentPending ? 'PENDING' : 'PAID')

        if (nextOrder?.fulfillmentTrackingNumber) {
          setShipment({
            shipmentId: nextOrder.id,
            trackingId: nextOrder.fulfillmentTrackingNumber,
            carrier: nextOrder.fulfillmentCarrier ?? nextOrder.bestRateCarrier ?? 'Amazon Shipping',
            service: nextOrder.fulfillmentService ?? nextOrder.bestRateService ?? 'Standard',
            shippingCost: nextOrder.fulfillmentShippingCost ?? nextOrder.bestRateAmount ?? 0,
            currencyCode: nextOrder.fulfillmentCurrency ?? nextOrder.bestRateCurrency ?? nextOrder.currencyCode,
            labelUrl: nextOrder.fulfillmentLabelUrl ?? '',
            collectAmount: nextOrder.paymentPending ? nextOrder.amountToCollect : '0.00'
          })
          setShipmentAlreadyExists(true)
        } else {
          setShipment(null)
          setShipmentAlreadyExists(false)
        }

        await loadDefaultPackage()
      } catch (requestError) {
        const message =
          requestError instanceof Error
            ? requestError.message
            : 'Unknown error while loading order details.'
        setError(message)
      } finally {
        setLoading(false)
      }
    }

    void loadOrderDetails()
  }, [legacyId, loadDefaultPackage])

  const printCurrentOrderInvoice = useCallback(() => {
    if (!order) {
      setError('Order details not available for invoice.')
      return
    }

    const html = buildInvoiceHtml([order], HARD_CODED_INVOICE_COMPANY)
    const printWindow = window.open('', '_blank', 'width=1000,height=900')
    if (!printWindow) {
      setError('Unable to open print window. Please allow popups for this site.')
      return
    }

    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
  }, [order])

  const generateLabel = useCallback(async () => {
    if (!legacyId) {
      setError('Invalid order id.')
      return
    }

    setGeneratingLabel(true)
    setError(null)
    setShipment(null)
    setShipmentAlreadyExists(false)

    try {
      setGenerationStep('Step 1: Authenticating with Amazon')
      setGenerationStep('Step 2: Getting shipping rates')

      const response = await fetch(`/api/orders/${legacyId}/generate-label`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ selectedRateId: selectedRateId || undefined })
      })

      setGenerationStep('Step 3: Selecting best rate')

      const payload = (await response.json()) as GenerateLabelResponse
      if (!response.ok || !payload.success) {
        throw new Error(payload.message ?? 'Failed to generate label.')
      }

      setGenerationStep('Step 4: Creating shipment')
      setGenerationStep('Step 5: Generating label')

      setShipment(payload.shipment)
      setShipmentAlreadyExists(Boolean(payload.alreadyExists))
      setGenerationStep('Step 6: Complete')
      setSuccess(payload.alreadyExists ? 'Existing shipment loaded.' : 'Label generated successfully.')
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while generating shipping label.'
      setError(message)
      setGenerationStep(null)
    } finally {
      setGeneratingLabel(false)
    }
  }, [legacyId, selectedRateId])

  const cancelManualOrder = useCallback(async () => {
    if (!legacyId || !order) return
    setCancellingOrder(true)
    setError(null)
    try {
      const response = await fetch(`/api/orders/${legacyId}/cancel`, { method: 'POST' })
      const payload = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !payload.order) throw new Error(payload.message ?? 'Failed to cancel manual order.')
      setOrder(payload.order)
      setSuccess(payload.message ?? 'Manual order cancelled.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to cancel manual order.')
    } finally {
      setCancellingOrder(false)
    }
  }, [legacyId, order])

  const openAddressEditor = useCallback(() => {
    if (!order) {
      return
    }

    const fallbackName = order.shippingAddress?.name?.trim() ?? ''
    const nameParts = fallbackName.length > 0 ? fallbackName.split(/\s+/) : []
    const fallbackFirst = nameParts[0] ?? ''
    const fallbackLast = nameParts.slice(1).join(' ')

    setAddressForm({
      firstName: order.customer?.firstName ?? fallbackFirst,
      lastName: order.customer?.lastName ?? fallbackLast,
      company: order.shippingAddress?.company ?? '',
      phone: order.shippingAddress?.phone ?? order.customer?.phone ?? '',
      email: order.customer?.email ?? '',
      address1: order.shippingAddress?.address1 ?? '',
      address2: order.shippingAddress?.address2 ?? '',
      city: order.shippingAddress?.city ?? '',
      province: order.shippingAddress?.province ?? '',
      zip: order.shippingAddress?.zip ?? '',
      country: order.shippingAddress?.country ?? 'India'
    })
    setEditingAddress(true)
  }, [order])

  const setAddressField = useCallback((field: keyof AddressEditForm, value: string) => {
    setAddressForm((current) => ({
      ...current,
      [field]: value
    }))
  }, [])

  const saveAddressDetails = useCallback(async () => {
    if (!legacyId) {
      setError('Invalid order id.')
      return
    }

    setSavingAddress(true)
    setError(null)

    try {
      const fullName = [addressForm.firstName.trim(), addressForm.lastName.trim()]
        .filter(Boolean)
        .join(' ')

      const payload: OrderUpdatePayload = {
        customer: {
          firstName: addressForm.firstName.trim() || undefined,
          lastName: addressForm.lastName.trim() || undefined,
          email: addressForm.email.trim() || undefined,
          phone: addressForm.phone.trim() || undefined
        },
        shippingAddress: {
          name: fullName || undefined,
          company: addressForm.company.trim() || undefined,
          address1: addressForm.address1.trim() || undefined,
          address2: addressForm.address2.trim() || undefined,
          city: addressForm.city.trim() || undefined,
          province: addressForm.province.trim() || undefined,
          zip: addressForm.zip.trim() || undefined,
          country: addressForm.country.trim() || undefined,
          phone: addressForm.phone.trim() || undefined
        }
      }

      const response = await fetch(`/api/orders/${legacyId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      const data = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !data.order) {
        throw new Error(data.message ?? 'Failed to update order details.')
      }

      setOrder(data.order)
      setEditingAddress(false)
      setSuccess('Order address updated.')
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while updating order details.'
      setError(message)
    } finally {
      setSavingAddress(false)
    }
  }, [addressForm, legacyId])

  return (
    <main className="dashboard details-ops-page">
      {loading ? <p className="status">Loading order details...</p> : null}
      <ApiToast error={error} success={success} />

      {!loading && order ? (
        <>
          <section className="details-ops-head">
            <div className="details-title-stack">
              <Link to="/" className="back-link details-back-link">
                {'<'}
              </Link>
              <h1>{order.name}</h1>
              <span className={`status-pill ${getOrderStatusMeta(order.fulfillmentStatus).className}`}>
                {getOrderStatusMeta(order.fulfillmentStatus).label}
              </span>
            </div>
            <div className="details-meta-row">
              <span>{formatDate(order.createdAt)}</span>
              <span>from Shopify</span>
              <span className="ops-mode-chip">{order.financialStatus}</span>
            </div>
            <div className="details-head-actions">
              <button className="filter-button" onClick={printCurrentOrderInvoice}>
                Generate Invoice
              </button>
              {order.id.startsWith('gid://store/ManualOrder/') && order.fulfillmentStatus !== 'CANCELLED' && !order.fulfillmentLabelUrl ? (
                <button className="filter-button" disabled={cancellingOrder || generatingLabel} onClick={() => void cancelManualOrder()}>
                  {cancellingOrder ? 'Cancelling...' : 'Cancel Manual Order'}
                </button>
              ) : null}
              <button
                className="sync-button"
                disabled={generatingLabel || order.fulfillmentStatus === 'CANCELLED' || order.fulfillmentStatus === 'FULFILLED'}
                title={order.fulfillmentStatus === 'FULFILLED' ? 'Order is already fulfilled in Shopify.' : undefined}
                onClick={() => void generateLabel()}
              >
                {generatingLabel
                  ? 'Generating Label...'
                  : order.fulfillmentStatus === 'FULFILLED'
                    ? 'Already Fulfilled'
                    : 'Generate Label'}
              </button>
            </div>
          </section>

          <section className="details-ops-grid">
            <div className="details-left-col">
              <article className="ops-card">
                <div className="ops-card-inline">
                  <p>
                    Fulfilled from{' '}
                    <strong>{order.shippingAddress?.address1 ?? order.shippingAddress?.city ?? 'Default Warehouse'}</strong>
                  </p>
                  <button className="mini-action" type="button" onClick={openAddressEditor}>
                    Edit
                  </button>
                </div>
              </article>

              <article className="ops-card">
                <div className="ops-card-header">
                  <h3>Rate Summary</h3>
                  <button
                    className="filter-button"
                    disabled={ratesLoading || !order}
                    onClick={() => {
                      if (order) {
                        void loadOrderRates(order.id)
                      }
                    }}
                  >
                    {ratesLoading ? 'Refreshing...' : 'Refresh Rates'}
                  </button>
                </div>
                <div className="rate-highlight">
                  Customer Selected Carrier &amp; Service at Checkout: -- | Rate:{' '}
                  {order.currencyCode} {order.amountToCollect}
                </div>
                {(() => {
                  const bestRate = selectBestRateOption(orderRates)
                  return (
                    <p className="muted compact">
                      Current Selected Carrier and Service:{' '}
                      <strong>
                        {shipment
                          ? `${shipment.carrier} - ${shipment.service}`
                          : bestRate
                            ? `${bestRate.carrierName} - ${bestRate.serviceName}`
                            : order.bestRateCarrier
                              ? `${order.bestRateCarrier}${order.bestRateService ? ` - ${order.bestRateService}` : ''}`
                              : 'Amazon Shipping - Standard'}
                      </strong>
                      {shipment
                        ? `, ${shipment.currencyCode} ${shipment.shippingCost}`
                        : bestRate
                          ? `, ${bestRate.currencyCode} ${bestRate.amount.toFixed(2)}`
                          : typeof order.bestRateAmount === 'number'
                            ? `, ${order.bestRateCurrency ?? order.currencyCode} ${order.bestRateAmount.toFixed(2)}`
                            : ''}
                    </p>
                  )
                })()}

                <table className="details-mini-table">
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Service</th>
                      <th>Status</th>
                      <th>Error</th>
                      <th>Cost</th>
                      <th>Transit</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {orderRates.length > 0 ? (
                      (() => {
                        const bestRate = selectBestRateOption(orderRates)
                        return orderRates.map((rate) => {
                          const isSelected = bestRate?.rateId === rate.rateId
                          const transit = rate.deliveryWindowStart && rate.deliveryWindowEnd
                            ? `${new Date(rate.deliveryWindowStart).toLocaleDateString('en-GB')} - ${new Date(rate.deliveryWindowEnd).toLocaleDateString('en-GB')}`
                            : 'N/A'

                          return (
                            <tr key={rate.rateId}>
                              <td>
                                <input
                                  type="radio"
                                  name="selected-shipping-rate"
                                  checked={selectedRateId === rate.rateId}
                                  disabled={rate.requiresAdditionalInputs}
                                  onChange={() => void saveSelectedRate(rate.rateId)}
                                  aria-label={`Select ${rate.carrierName} ${rate.serviceName}`}
                                />
                              </td>
                              <td>{rate.carrierName} - {rate.serviceName}</td>
                              <td>{rate.requiresAdditionalInputs ? 'REQUIRES_INPUTS' : 'SUCCESS'}</td>
                              <td>--</td>
                              <td>{rate.currencyCode} {rate.amount.toFixed(2)}</td>
                              <td>{transit}</td>
                              <td className="mini-table-mark">{isSelected ? 'BEST' : ''}</td>
                            </tr>
                          )
                        })
                      })()
                    ) : typeof order.bestRateAmount === 'number' ? (
                      <tr>
                        <td />
                        <td>
                          {order.bestRateCarrier ?? 'Amazon Shipping'}
                          {order.bestRateService ? ` - ${order.bestRateService}` : ''}
                        </td>
                        <td>CACHED</td>
                        <td>Live rate unavailable</td>
                        <td>
                          {order.bestRateCurrency ?? order.currencyCode} {order.bestRateAmount.toFixed(2)}
                        </td>
                        <td>N/A</td>
                        <td className="mini-table-mark">BEST</td>
                      </tr>
                    ) : (
                      <tr>
                        <td colSpan={7}>{ratesLoading ? 'Loading rates...' : 'No rates available yet.'}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </article>

              <article className="ops-card">
                <div className="ops-card-header">
                  <h3>Packing Summary</h3>
                  <button className="mini-action" type="button" onClick={openAddressEditor}>
                    Edit
                  </button>
                </div>

                <div className="packing-meta-row">
                  <span>
                    Packaging Type: <strong>Weight Based</strong>
                  </span>
                  <span>
                    Box Name:{' '}
                    <select
                      value={selectedPackageProfileId || defaultPackage?.id || ''}
                      disabled={savingPackage || savingPaymentStatus || packageProfiles.length === 0}
                      onChange={(event) => setSelectedPackageProfileId(event.target.value)}
                    >
                      {packageProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} ({profile.lengthCm} x {profile.widthCm} x {profile.heightCm} cm, {profile.weightKg} kg)
                        </option>
                      ))}
                    </select>
                  </span>
                  <span>
                    Dimensions:{' '}
                    <strong>
                      {(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage)
                        ? `${(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage)!.lengthCm} x ${(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage)!.widthCm} x ${(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage)!.heightCm} cm`
                        : '--'}
                    </strong>
                  </span>
                  <span>
                    Weight: <strong>{(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage) ? `${(packageProfiles.find((profile) => profile.id === (selectedPackageProfileId || defaultPackage?.id)) ?? defaultPackage)!.weightKg} kg` : '--'}</strong>
                  </span>
                  <span>
                    Payment:{' '}
                    <select
                      value={selectedPaymentStatus}
                      disabled={savingPackage || savingPaymentStatus}
                      onChange={(event) => setSelectedPaymentStatus(event.target.value as 'PENDING' | 'PAID')}
                    >
                      <option value="PENDING">COD / Pending</option>
                      <option value="PAID">Prepaid / Paid</option>
                    </select>
                  </span>
                  <button
                    className="sync-button"
                    type="button"
                    disabled={savingPackage || savingPaymentStatus || !selectedPackageProfileId && !defaultPackage?.id}
                    onClick={() => void saveFulfillmentDetails()}
                  >
                    {savingPackage ? 'Saving & Refreshing...' : 'Save Changes'}
                  </button>
                </div>

                <table className="details-mini-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>SKU</th>
                      <th>Cost</th>
                      <th>Quantity</th>
                      <th>Weight</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lineItems.map((item, index) => (
                      <tr key={`${order.id}-${index}`}>
                        <td>{item.title}</td>
                        <td>--</td>
                        <td>
                          {item.currencyCode} {item.unitPrice}
                        </td>
                        <td>{item.quantity}</td>
                        <td>{(item.quantity * 0.1).toFixed(2)} kgs</td>
                        <td>
                          {item.currencyCode} {(Number(item.unitPrice) * item.quantity).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>

              {generationStep ? <p className="muted">{generationStep}</p> : null}

              {shipment ? (
                <section className="shipment-result">
                  <h3>{shipmentAlreadyExists ? 'Shipment Already Exists' : 'Shipment Created'}</h3>
                  <p>
                    <strong>AWB / Tracking:</strong>{' '}
                    <a href={toAmazonTrackingUrl(shipment.trackingId)} target="_blank" rel="noreferrer">
                      {shipment.trackingId}
                    </a>
                  </p>
                  <p>
                    <strong>Collect Amount:</strong> {shipment.collectAmount} {shipment.currencyCode}
                  </p>
                  <div className="shipment-actions">
                    {shipment.labelUrl ? (
                      <>
                        <a href={shipment.labelUrl} className="details-link" target="_blank" rel="noreferrer">
                          View Label
                        </a>
                        <a href={shipment.labelUrl} className="details-link" target="_blank" rel="noreferrer" download>
                          Download Label
                        </a>
                      </>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="details-right-col">
              {order.fulfillmentStatus === 'FULFILLED' && shipment ? (
                <article className="ops-card side-card tracking-card">
                  <h3>Tracking</h3>
                  <p>
                    <strong>{shipment.carrier}</strong>
                    {shipment.service ? ` - ${shipment.service}` : ''}
                  </p>
                  <p className="tracking-number">{shipment.trackingId}</p>
                  <a
                    className="sync-button tracking-link"
                    href={toAmazonTrackingUrl(shipment.trackingId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Tracking
                  </a>
                </article>
              ) : null}

              <article className="ops-card side-card">
                <div className="ops-card-header">
                  <h3>Recipient</h3>
                  <button className="mini-action" type="button" onClick={openAddressEditor}>
                    Edit
                  </button>
                </div>
                <p>{order.shippingAddress?.name ?? '--'}</p>
                <p>{order.shippingAddress?.phone ?? '--'}</p>
                <h4>Address</h4>
                <p>{addressToText(order.shippingAddress)}</p>
              </article>

              <article className="ops-card side-card">
                <div className="ops-card-header">
                  <h3>Billing</h3>
                  <button className="mini-action" type="button" onClick={openAddressEditor}>
                    Edit
                  </button>
                </div>
                <p>{order.shippingAddress?.name ?? '--'}</p>
                <p>{order.shippingAddress?.phone ?? '--'}</p>
                <h4>Address</h4>
                <p>{addressToText(order.shippingAddress)}</p>
              </article>

              <article className="ops-card side-card">
                <h3>Order Cost Summary</h3>
                <div className="summary-row">
                  <span>Order Total</span>
                  <strong>
                    {order.currencyCode} {order.totalPrice}
                  </strong>
                </div>
              </article>

              <article className="ops-card side-card">
                <h3>Special Services</h3>
                <p>Dangerous Goods: No</p>
                <p>Collect on Delivery: {order.paymentPending ? 'Yes' : 'No'}</p>
              </article>
            </aside>
          </section>

          {editingAddress ? (
            <section className="details-modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit shipping details">
              <div className="details-modal-sheet">
                <div className="details-modal-body">
                  <h2>Shipping Address</h2>

                  <div className="field-grid">
                    <label>
                      First Name <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.firstName}
                        onChange={(event) => setAddressField('firstName', event.target.value)}
                      />
                    </label>
                    <label>
                      Last Name <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.lastName}
                        onChange={(event) => setAddressField('lastName', event.target.value)}
                      />
                    </label>
                    <label>
                      Company Name <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.company}
                        onChange={(event) => setAddressField('company', event.target.value)}
                      />
                    </label>
                    <label>
                      Phone Number <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.phone}
                        onChange={(event) => setAddressField('phone', event.target.value)}
                      />
                    </label>
                    <label>
                      Email-ID <span className="required-mark">*</span>
                      <input
                        type="email"
                        value={addressForm.email}
                        onChange={(event) => setAddressField('email', event.target.value)}
                      />
                    </label>
                    <label>
                      Street Address 1 <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.address1}
                        onChange={(event) => setAddressField('address1', event.target.value)}
                      />
                    </label>
                    <label>
                      Street Address 2
                      <input
                        type="text"
                        value={addressForm.address2}
                        onChange={(event) => setAddressField('address2', event.target.value)}
                      />
                    </label>
                    <label>
                      City <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.city}
                        onChange={(event) => setAddressField('city', event.target.value)}
                      />
                    </label>
                    <label>
                      State <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.province}
                        onChange={(event) => setAddressField('province', event.target.value)}
                      />
                    </label>
                    <label>
                      Postal Code <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.zip}
                        onChange={(event) => setAddressField('zip', event.target.value)}
                      />
                    </label>
                    <label>
                      Country <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={addressForm.country}
                        onChange={(event) => setAddressField('country', event.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="details-modal-footer">
                  <button className="modal-link-button" type="button" onClick={() => setEditingAddress(false)}>
                    Close
                  </button>
                  <button className="modal-link-button save" type="button" disabled={savingAddress} onClick={() => void saveAddressDetails()}>
                    {savingAddress ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  )
}

function SettingsPage() {
  const [profiles, setProfiles] = useState<PackageProfile[]>([])
  const [defaultPackage, setDefaultPackage] = useState<DefaultPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [newProfile, setNewProfile] = useState({
    name: '',
    lengthCm: '20',
    widthCm: '15',
    heightCm: '10',
    weightKg: '0.5',
    setAsDefault: true
  })

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/packaging')
      const payload = (await response.json()) as PackagingSettingsResponse & { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to load settings.')
      }

      setProfiles(payload.profiles)
      setDefaultPackage(payload.defaultPackage)
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unknown settings error.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const createProfile = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/packaging/profiles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newProfile.name.trim(),
          lengthCm: Number(newProfile.lengthCm),
          widthCm: Number(newProfile.widthCm),
          heightCm: Number(newProfile.heightCm),
          weightKg: Number(newProfile.weightKg),
          setAsDefault: newProfile.setAsDefault
        })
      })

      const payload = (await response.json()) as { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to create package profile.')
      }

      setNewProfile((current) => ({
        ...current,
        name: ''
      }))
      await loadSettings()
      setSuccess('Package profile created.')
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unknown create error.'
      setError(message)
    } finally {
      setSaving(false)
    }
  }, [loadSettings, newProfile])

  const setDefault = useCallback(async (profileId: string) => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/packaging/default', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ profileId })
      })
      const payload = (await response.json()) as { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to set default package.')
      }

      await loadSettings()
      setSuccess('Default package updated.')
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unknown update error.'
      setError(message)
    } finally {
      setSaving(false)
    }
  }, [loadSettings])

  return (
    <main className="dashboard settings-page">
      <section className="settings-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Basic Shipping Settings</h1>
          <p className="subtitle">Create box sizes in cm, choose default box and weight, and use it in label generation.</p>
        </div>
        <Link to="/" className="filter-button settings-back-link">
          Back to Orders
        </Link>
      </section>

      <ApiToast error={error} success={success} />

      <section className="settings-grid">
        <article className="settings-card">
          <h3>Package Defaults Used For Labels</h3>
          {defaultPackage ? (
            <div className="settings-default-box">
              <p><strong>Name:</strong> {defaultPackage.name}</p>
              <p><strong>Dimensions:</strong> {defaultPackage.lengthCm} x {defaultPackage.widthCm} x {defaultPackage.heightCm} cm</p>
              <p><strong>Weight:</strong> {defaultPackage.weightKg} kg</p>
            </div>
          ) : (
            <p className="muted">No default package configured.</p>
          )}
        </article>

        <article className="settings-card">
          <h3>Create New Box Profile</h3>
          <div className="settings-form-grid">
            <label>
              Box Name
              <input
                type="text"
                value={newProfile.name}
                onChange={(event) => setNewProfile((current) => ({ ...current, name: event.target.value }))}
                placeholder="Small Box"
              />
            </label>
            <label>
              Length (cm)
              <input
                type="number"
                step="0.1"
                value={newProfile.lengthCm}
                onChange={(event) => setNewProfile((current) => ({ ...current, lengthCm: event.target.value }))}
              />
            </label>
            <label>
              Width (cm)
              <input
                type="number"
                step="0.1"
                value={newProfile.widthCm}
                onChange={(event) => setNewProfile((current) => ({ ...current, widthCm: event.target.value }))}
              />
            </label>
            <label>
              Height (cm)
              <input
                type="number"
                step="0.1"
                value={newProfile.heightCm}
                onChange={(event) => setNewProfile((current) => ({ ...current, heightCm: event.target.value }))}
              />
            </label>
            <label>
              Weight (kg)
              <input
                type="number"
                step="0.01"
                value={newProfile.weightKg}
                onChange={(event) => setNewProfile((current) => ({ ...current, weightKg: event.target.value }))}
              />
            </label>
            <label className="dry-run-toggle">
              <input
                type="checkbox"
                checked={newProfile.setAsDefault}
                onChange={(event) => setNewProfile((current) => ({ ...current, setAsDefault: event.target.checked }))}
              />
              Set as default
            </label>
          </div>
          <button className="sync-button" disabled={saving} onClick={() => void createProfile()}>
            {saving ? 'Saving...' : 'Save Box Profile'}
          </button>
        </article>

        <article className="settings-card settings-card-wide">
          <h3>Saved Box Profiles</h3>
          {loading ? (
            <p className="status">Loading package profiles...</p>
          ) : profiles.length === 0 ? (
            <p className="status">No package profiles yet.</p>
          ) : (
            <table className="orders-table settings-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Length (cm)</th>
                  <th>Width (cm)</th>
                  <th>Height (cm)</th>
                  <th>Weight (kg)</th>
                  <th>Default</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>{profile.name}</td>
                    <td>{profile.lengthCm}</td>
                    <td>{profile.widthCm}</td>
                    <td>{profile.heightCm}</td>
                    <td>{profile.weightKg}</td>
                    <td>{profile.isDefault ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        className="mini-action"
                        disabled={saving || profile.isDefault}
                        onClick={() => void setDefault(profile.id)}
                      >
                        {profile.isDefault ? 'Current Default' : 'Set Default'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>
    </main>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/labels" element={<LabelsPage />} />
      <Route path="/orders/:legacyId" element={<OrderDetailsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  )
}

export default App
