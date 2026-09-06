import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { PDFDocument } from 'pdf-lib'
import * as XLSX from 'xlsx'
import { BrowserMultiFormatReader } from '@zxing/browser'
import './App.css'

type OrderFilter = 'all' | 'open' | 'fulfilled'

interface OrderLineItem {
  title: string
  quantity: number
  unitPrice: string
  currencyCode: string
  taxAmount?: string
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
  estimatedDeliveryStart?: string | null
  estimatedDeliveryEnd?: string | null
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

interface FulfillmentAddressResponse {
  fulfillmentAddress: ShippingAddress
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

interface InvoiceFulfillmentForm {
  carrier: string
  service: string
  trackingNumber: string
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

function addPackingSlipPage(pdf: PDFDocument, order: OrderSummary): void {
  const page = pdf.addPage([595, 842])
  const { height } = page.getSize()
  page.drawText('Packing Slip', { x: 42, y: height - 58, size: 22 })
  page.drawText(`Order: ${order.name}`, { x: 42, y: height - 92, size: 13 })
  page.drawText('Products', { x: 42, y: height - 132, size: 12 })

  order.lineItems.forEach((item, index) => {
    const title = item.title.length > 72 ? `${item.title.slice(0, 69)}...` : item.title
    page.drawText(`${index + 1}. ${title} x ${item.quantity}`, {
      x: 52,
      y: height - 160 - index * 24,
      size: 11
    })
  })
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
  const invoiceLogoUrl = new URL('/wobble_bag_logo.png', window.location.origin).href

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

      return `
        <section class="invoice ${orderIndex < sourceOrders.length - 1 ? 'page-break' : ''}">
          <div class="invoice-header">
            <div class="cell seller-info">
              <img class="seller-logo" src="${invoiceLogoUrl}" alt="WobbleBag logo" />
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
              <div class="field-row">
                <div class="field-label">Tracking Company</div>
                <div class="field-value">${escapeHtml(trackingCarrier)}</div>
              </div>
              <div class="field-row">
                <div class="field-label">Tracking Number</div>
                <div class="field-value">${escapeHtml(trackingNumber)}</div>
              </div>
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
          .invoice-header { display: grid; grid-template-columns: 1.3fr 1.5fr 1.3fr; border: 1px solid #222; }
          .seller-info { min-height: 240px; }
          .seller-logo { width: 100px; height: 60px; object-fit: contain; display: block; margin-bottom: 10px; }
          .invoice-title { text-align: center; font-weight: bold; font-size: 16px; margin-bottom: 10px; }
          .field-row { display: grid; grid-template-columns: 1fr 1.2fr; border-bottom: 1px solid #222; }
          .field-row:last-child { border-bottom: none; }
          .field-label { font-weight: bold; padding: 5px; border-right: 1px solid #222; }
          .field-value { padding: 5px; word-break: break-word; }
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
  if (normalized === 'UNFULFILLED') {
    return { label: ORDER_STATUS_LABELS[normalized], className: 'urgent' }
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

function isFulfillmentOverdue(order: OrderSummary): boolean {
  const normalized = order.fulfillmentStatus?.toUpperCase()
  if (normalized === 'FULFILLED' || normalized === 'CANCELLED' || normalized === 'RESTOCKED') {
    return false
  }

  const deadline = toEpochMs(order.createdAt) + 24 * 60 * 60 * 1000
  return Number.isFinite(deadline) && deadline < Date.now()
}

function toEpochMs(value: string | null | undefined): number {
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
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'cod' | 'prepaid' | 'partial'>('all')
  const [urgencyFilter, setUrgencyFilter] = useState<'all' | 'overdue'>('all')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [productMatchFilter, setProductMatchFilter] = useState<'including' | 'only'>('including')
  const [cityFilter, setCityFilter] = useState<string>('all')
  const [dateFromFilter, setDateFromFilter] = useState('')
  const [dateToFilter, setDateToFilter] = useState('')
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])
  const [ratePreview, setRatePreview] = useState<OrderRatesPreview[] | null>(null)
  const [selectedRateByOrderId, setSelectedRateByOrderId] = useState<Record<string, string>>({})
  const [showBatchCostConfirmation, setShowBatchCostConfirmation] = useState(false)
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

  const productOptions = useMemo(() => {
    const values = new Set<string>()
    for (const order of orders) {
      for (const lineItem of order.lineItems) {
        const title = lineItem.title.trim()
        if (title) {
          values.add(title)
        }
      }
    }

    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [orders])

  const filteredOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const fromMs = dateFromFilter ? Date.parse(`${dateFromFilter}T00:00:00`) : null
    const toMs = dateToFilter ? Date.parse(`${dateToFilter}T23:59:59.999`) : null

    const visibleOrders = orders.filter((order) => {
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

      if (paymentFilter === 'partial' && order.financialStatus.toUpperCase() !== 'PARTIALLY_PAID') {
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

      if (urgencyFilter === 'overdue' && !isFulfillmentOverdue(order)) {
        return false
      }

      if (productFilter !== 'all') {
        const productTitles = order.lineItems.map((lineItem) => lineItem.title.trim()).filter(Boolean)
        const includesProduct = productTitles.includes(productFilter)
        const onlySelectedProduct = includesProduct && productTitles.every((title) => title === productFilter)

        if (productMatchFilter === 'only' ? !onlySelectedProduct : !includesProduct) {
          return false
        }
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

    if (activeFilter !== 'open') {
      return visibleOrders
    }

    return [...visibleOrders].sort((a, b) => toEpochMs(a.createdAt) - toEpochMs(b.createdAt))
  }, [activeFilter, carrierFilter, cityFilter, dateFromFilter, dateToFilter, orders, paymentFilter, productFilter, productMatchFilter, searchQuery, urgencyFilter])

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

  const submitBatch = useCallback(async (
    selectedRates?: Record<string, string>,
    orderIds: string[] = selectedOrderIds
  ) => {
    setBatching(true)
    setError(null)

    try {
      const response = await fetch('/api/fulfillment/batches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          orderIds,
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
      setShowBatchCostConfirmation(true)
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : 'Unknown error while fetching rates.'
      setError(message)
    } finally {
      setLoadingRates(false)
    }
  }, [selectedOrderIds])

  const batchCostTotals = useMemo(() => {
    const totals = new Map<string, number>()

    for (const entry of ratePreview ?? []) {
      const selectedRateId = selectedRateByOrderId[entry.orderId]
      const selectedRate = entry.rates.find((rate) => rate.rateId === selectedRateId)
      if (!selectedRate) {
        continue
      }

      totals.set(
        selectedRate.currencyCode,
        (totals.get(selectedRate.currencyCode) ?? 0) + selectedRate.amount
      )
    }

    return Array.from(totals.entries())
  }, [ratePreview, selectedRateByOrderId])

  const acceptBatchCost = useCallback(async () => {
    const orderIdsWithRates = Object.keys(selectedRateByOrderId)
    if (orderIdsWithRates.length === 0) {
      setShowBatchCostConfirmation(false)
      setError('No selected orders have a usable shipping rate.')
      return
    }

    setShowBatchCostConfirmation(false)
    await submitBatch(selectedRateByOrderId, orderIdsWithRates)
  }, [selectedRateByOrderId, submitBatch])

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
          <span className="ops-mode-chip">Total: {filteredOrders.length}</span>
          <span className="ops-mode-chip">Mode: {shippingMode.toUpperCase()}</span>
          <button className="filter-button" onClick={() => navigate('/settings')}>
            Settings
          </button>
          <button className="filter-button" onClick={() => navigate('/labels')}>
            Labels
          </button>
          <button className="filter-button" onClick={() => navigate('/gst-work')}>
            GST Work
          </button>
          <button className="filter-button" onClick={() => navigate('/fulfillment')}>
            Fulfillment
          </button>
          <button className="filter-button" onClick={() => navigate('/fulfillment-plan')}>
            Products to Prepare
          </button>
          <button className="filter-button" onClick={() => navigate('/scan')}>
            Scan Shipment
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
            onChange={(event) => setPaymentFilter(event.target.value as 'all' | 'cod' | 'prepaid' | 'partial')}
          >
            <option value="all">All Payments</option>
            <option value="cod">COD</option>
            <option value="prepaid">Prepaid</option>
            <option value="partial">Partially Paid</option>
          </select>
          <select
            className="ops-select"
            value={urgencyFilter}
            onChange={(event) => setUrgencyFilter(event.target.value as 'all' | 'overdue')}
            aria-label="Fulfillment urgency"
          >
            <option value="all">All Fulfillment</option>
            <option value="overdue">Overdue Fulfillment</option>
          </select>
          <select
            className="ops-select"
            value={productFilter}
            onChange={(event) => setProductFilter(event.target.value)}
            aria-label="Product"
          >
            <option value="all">All Products</option>
            {productOptions.map((product) => (
              <option key={product} value={product}>
                {product}
              </option>
            ))}
          </select>
          <select
            className="ops-select"
            value={productMatchFilter}
            onChange={(event) => setProductMatchFilter(event.target.value as 'including' | 'only')}
            aria-label="Product matching"
          >
            <option value="including">Including Product</option>
            <option value="only">Only This Product</option>
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

      {showBatchCostConfirmation ? (
        <div className="batch-cost-modal-backdrop" role="presentation">
          <section className="batch-cost-modal" role="dialog" aria-modal="true" aria-labelledby="batch-cost-title">
            <h2 id="batch-cost-title">Confirm batch label cost</h2>
            <p>This batch will cost:</p>
            {ratePreview && Object.keys(selectedRateByOrderId).length < ratePreview.length ? (
              <p className="batch-cost-warning">
                {ratePreview.length - Object.keys(selectedRateByOrderId).length} order(s) will be omitted because no usable rate was found.
              </p>
            ) : null}
            <div className="batch-cost-total">
              {batchCostTotals.map(([currency, amount]) => (
                <strong key={currency}>
                  {currency} {amount.toFixed(2)}
                </strong>
              ))}
            </div>
            <div className="batch-cost-actions">
              <button className="filter-button" disabled={batching} onClick={() => setShowBatchCostConfirmation(false)}>
                Reject
              </button>
              <button className="sync-button" disabled={batching} onClick={() => void acceptBatchCost()}>
                {batching ? 'Generating...' : 'Accept & Generate Labels'}
              </button>
            </div>
          </section>
        </div>
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
                      <div className="status-stack">
                        <span className={`status-pill ${getOrderStatusMeta(order.fulfillmentStatus).className}`}>
                          {getOrderStatusMeta(order.fulfillmentStatus).label}
                        </span>
                        {isFulfillmentOverdue(order) ? (
                          <span className="status-pill overdue">Fulfillment overdue</span>
                        ) : null}
                      </div>
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
        if (job.order) {
          addPackingSlipPage(mergedPdf, job.order)
        }
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
              <td>{job.order?.name ?? job.orderId.split('/').pop()}</td><td>{job.trackingNumber ?? '--'}</td><td>{job.carrier ?? '--'}</td><td>{job.order?.lineItems.map((item) => `${item.title} x ${item.quantity}`).join(', ') ?? '--'}</td><td>{job.status}</td>
            </tr>) : null}
          </Fragment>
        })}
      </tbody></table>
      {groups.length === 0 ? <p className="status">No label groups created yet.</p> : null}
    </section>
  </main>
}

function GstWorkPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const taxBearingItems = (order: OrderSummary) =>
    order.lineItems.filter((item) => Number(item.taxAmount ?? 0) > 0)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/orders?status=all')
      const payload = (await response.json()) as OrdersResponse & { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to load orders.')
      }

      setOrders(payload.orders)
      setSelectedOrderIds(payload.orders.filter((order) => taxBearingItems(order).length > 0).map((order) => order.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load orders.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  const selectableOrders = orders.filter((order) => taxBearingItems(order).length > 0)
  const allSelected = selectableOrders.length > 0 && selectedOrderIds.length === selectableOrders.length

  const toggleOrder = (orderId: string) => {
    setSelectedOrderIds((current) =>
      current.includes(orderId)
        ? current.filter((id) => id !== orderId)
        : [...current, orderId]
    )
  }

  const exportGstWorkbook = () => {
    const selectedOrders = orders.filter((order) => selectedOrderIds.includes(order.id))
    if (selectedOrders.length === 0) {
      setError('Select at least one order to export.')
      return
    }

    const rows = selectedOrders.flatMap((order) =>
      order.lineItems
        .filter((item) => Number(item.taxAmount ?? 0) > 0)
        .map((item) => ({
        'Order Number': order.name,
        'Order Date': new Date(order.createdAt).toLocaleDateString('en-IN'),
        Product: item.title,
        Quantity: item.quantity,
        'Sell Price (Rate)': Number(item.unitPrice),
        'Taxable Amount': Number(item.unitPrice) * item.quantity,
        'Tax Amount': Number(item.taxAmount),
        'Point of Supply': order.shippingAddress?.province ?? '',
        'Payment Type': order.paymentPending ? 'COD / Pending' : 'Prepaid / Paid'
        }))
    )

    if (rows.length === 0) {
      setError('No tax-bearing products found in the selected orders.')
      return
    }

    const worksheet = XLSX.utils.json_to_sheet(rows)
    worksheet['!cols'] = [
      { wch: 16 }, { wch: 14 }, { wch: 48 }, { wch: 10 },
      { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 20 }, { wch: 18 }
    ]
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'GST Work')
    XLSX.writeFile(workbook, `gst-work-${new Date().toISOString().slice(0, 10)}.xlsx`)
    setSuccess(`Exported ${selectedOrders.length} order(s) to Excel.`)
  }

  return (
    <main className="dashboard ops-page">
      <section className="ops-topbar">
        <div>
          <p className="eyebrow">Finance</p>
          <h1>GST Work</h1>
          <p className="subtitle">Export order product and tax details to Excel.</p>
        </div>
        <div className="ops-top-actions">
          <button className="filter-button" onClick={() => navigate('/')}>Orders</button>
          <button className="filter-button" onClick={() => void loadOrders()}>Refresh</button>
          <button className="sync-button" disabled={selectedOrderIds.length === 0} onClick={exportGstWorkbook}>
            Export Excel ({selectedOrderIds.length})
          </button>
        </div>
      </section>

      <ApiToast error={error} success={success} />

      <section className="ops-shell">
        <div className="ops-tabs">
          <span className="ops-total-count">{orders.length} orders loaded</span>
          <button className="filter-button" onClick={() => setSelectedOrderIds(allSelected ? [] : selectableOrders.map((order) => order.id))}>
            {allSelected ? 'Unselect All' : 'Select All Taxed Orders'}
          </button>
        </div>
      </section>

      {loading ? <p className="status">Loading orders...</p> : orders.length === 0 ? <p className="status">No orders available.</p> : (
        <section className="orders-table-wrap">
          <table className="orders-table">
            <thead>
              <tr>
                <th className="cell-check" />
                <th>Order</th>
                <th>Date</th>
                <th>Products</th>
                <th>Point of Supply</th>
                <th>Payment Type</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const taxedItems = taxBearingItems(order)
                return (
                <tr key={order.id}>
                  <td className="cell-check">
                    <input
                      type="checkbox"
                      checked={selectedOrderIds.includes(order.id)}
                      disabled={taxedItems.length === 0}
                      onChange={() => toggleOrder(order.id)}
                      aria-label={`Select ${order.name} for GST export`}
                    />
                  </td>
                  <td><strong>{order.name}</strong></td>
                  <td>{new Date(order.createdAt).toLocaleDateString('en-IN')}</td>
                  <td>{taxedItems.length > 0 ? taxedItems.map((item) => `${item.title} x ${item.quantity}`).join(', ') : 'No tax-bearing products'}</td>
                  <td>{order.shippingAddress?.province ?? '--'}</td>
                  <td>{order.paymentPending ? 'COD / Pending' : 'Prepaid / Paid'}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}

function FulfillmentDashboardPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shipmentStatusFilter, setShipmentStatusFilter] = useState<'all' | 'to-ship' | 'in-transit'>('all')

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/orders?status=all')
      const payload = (await response.json()) as OrdersResponse & { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to load fulfillment data.')
      }
      setOrders(payload.orders)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load fulfillment data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOrders()
  }, [loadOrders])

  const toShip = orders.filter((order) => {
    const status = order.fulfillmentStatus.toUpperCase()
    return status !== 'FULFILLED' && status !== 'CANCELLED' && !order.fulfillmentTrackingNumber
  }).length
  const inTransit = orders.filter((order) => Boolean(order.fulfillmentTrackingNumber) || order.fulfillmentStatus.toUpperCase() === 'FULFILLED').length
  const delivered = 0
  const returns = 0
  const totalTracked = toShip + inTransit
  const chartValues = [
    { label: 'To Ship', value: toShip, className: 'to-ship' },
    { label: 'In Transit', value: inTransit, className: 'in-transit' },
    { label: 'Delivered', value: delivered, className: 'delivered' },
    { label: 'Returns', value: returns, className: 'returns' }
  ]
  const shipmentRows = orders
    .map((order) => {
      const isInTransit = Boolean(order.fulfillmentTrackingNumber) || order.fulfillmentStatus.toUpperCase() === 'FULFILLED'
      return { order, status: isInTransit ? 'in-transit' as const : 'to-ship' as const }
    })
    .filter((entry) => shipmentStatusFilter === 'all' || entry.status === shipmentStatusFilter)

  return (
    <main className="dashboard ops-page">
      <section className="ops-topbar">
        <div>
          <p className="eyebrow">Amazon Fulfillment</p>
          <h1>Fulfillment Dashboard</h1>
          <p className="subtitle">One view for shipping workload and shipment progress.</p>
        </div>
        <div className="ops-top-actions">
          <button className="filter-button" onClick={() => navigate('/')}>Orders</button>
          <button className="filter-button" onClick={() => void loadOrders()}>Refresh</button>
        </div>
      </section>

      <ApiToast error={error} success={null} />

      <section className="fulfillment-summary-grid">
        {chartValues.map((item) => (
          <article className={`fulfillment-stat ${item.className}`} key={item.label}>
            <span>{item.label}</span>
            <strong>{loading ? '--' : item.value}</strong>
            {item.label === 'Delivered' || item.label === 'Returns' ? <small>Amazon status sync needed</small> : null}
          </article>
        ))}
      </section>

      <section className="fulfillment-dashboard-grid">
        <article className="ops-card fulfillment-chart-card">
          <div className="ops-card-header">
            <div>
              <h3>Shipment Report</h3>
              <p className="muted compact">Current local fulfillment state</p>
            </div>
            <span className="ops-mode-chip">{totalTracked} tracked</span>
          </div>
          <div className="fulfillment-bars">
            {chartValues.map((item) => {
              const width = totalTracked > 0 ? Math.max(item.value > 0 ? 4 : 0, (item.value / totalTracked) * 100) : 0
              return (
                <div className="fulfillment-bar-row" key={item.label}>
                  <span>{item.label}</span>
                  <div className="fulfillment-bar-track"><div className={`fulfillment-bar ${item.className}`} style={{ width: `${width}%` }} /></div>
                  <strong>{item.value}</strong>
                </div>
              )
            })}
          </div>
        </article>

        <article className="ops-card fulfillment-note-card">
          <h3>Amazon tracking status</h3>
          <p>Labels and tracking numbers are stored locally after shipment creation.</p>
          <p className="muted">Delivered and return counts need a tracking-status API integration. They are not inferred from Shopify fulfillment, because Shopify “fulfilled” means the label was created, not that the parcel arrived.</p>
        </article>
      </section>

      <section className="ops-card fulfillment-list-card">
        <div className="ops-card-header">
          <div>
            <h3>Shipments</h3>
            <p className="muted compact">Orders and Amazon tracking data currently stored in this system.</p>
          </div>
          <select className="ops-select" value={shipmentStatusFilter} onChange={(event) => setShipmentStatusFilter(event.target.value as 'all' | 'to-ship' | 'in-transit')}>
            <option value="all">All Shipments</option>
            <option value="to-ship">To Ship</option>
            <option value="in-transit">In Transit</option>
          </select>
        </div>
        {shipmentRows.length === 0 ? <p className="status">No shipments for this status.</p> : (
          <div className="orders-table-wrap">
            <table className="orders-table fulfillment-list-table">
              <thead><tr><th>Order</th><th>Status</th><th>Tracking Number</th><th>Carrier</th><th>Created</th><th>Action</th></tr></thead>
              <tbody>
                {shipmentRows.map(({ order, status }) => (
                  <tr key={order.id}>
                    <td><strong>{order.name}</strong></td>
                    <td><span className={`status-pill ${status === 'in-transit' ? 'fulfilled' : 'urgent'}`}>{status === 'in-transit' ? 'In Transit' : 'To Ship'}</span></td>
                    <td>{order.fulfillmentTrackingNumber ?? '--'}</td>
                    <td>{order.fulfillmentCarrier ?? order.bestRateCarrier ?? '--'}</td>
                    <td>{new Date(order.createdAt).toLocaleDateString('en-IN')}</td>
                    <td><button className="mini-action" onClick={() => navigate(`/orders/${getLegacyOrderId(order.id)}`)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

function FulfillmentPlanPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOpenOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/orders?status=open')
      const payload = (await response.json()) as OrdersResponse & { message?: string }
      if (!response.ok) {
        throw new Error(payload.message ?? 'Failed to load open orders.')
      }
      setOrders(payload.orders.filter((order) => {
        const status = order.fulfillmentStatus.toUpperCase()
        return status !== 'FULFILLED' && status !== 'CANCELLED'
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load open orders.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOpenOrders()
  }, [loadOpenOrders])

  const productPlan = useMemo(() => {
    const totals = new Map<string, { quantity: number; orderCount: number }>()

    for (const order of orders) {
      const quantitiesByProduct = new Map<string, number>()
      for (const item of order.lineItems) {
        const product = item.title.trim() || 'Unnamed product'
        quantitiesByProduct.set(product, (quantitiesByProduct.get(product) ?? 0) + item.quantity)
      }

      for (const [product, quantity] of quantitiesByProduct) {
        const current = totals.get(product) ?? { quantity: 0, orderCount: 0 }
        totals.set(product, {
          quantity: current.quantity + quantity,
          orderCount: current.orderCount + 1
        })
      }
    }

    return Array.from(totals.entries())
      .map(([product, values]) => ({ product, ...values }))
      .sort((a, b) => b.quantity - a.quantity || a.product.localeCompare(b.product))
  }, [orders])

  const totalUnits = productPlan.reduce((sum, item) => sum + item.quantity, 0)

  return (
    <main className="dashboard ops-page">
      <section className="ops-topbar">
        <div>
          <p className="eyebrow">Fulfillment Planning</p>
          <h1>Products to Prepare</h1>
          <p className="subtitle">Required quantities from current open orders.</p>
        </div>
        <div className="ops-top-actions">
          <button className="filter-button" onClick={() => navigate('/fulfillment')}>Fulfillment</button>
          <button className="filter-button" onClick={() => navigate('/')}>Orders</button>
          <button className="filter-button" onClick={() => void loadOpenOrders()}>Refresh</button>
        </div>
      </section>

      <ApiToast error={error} success={null} />

      <section className="fulfillment-summary-grid">
        <article className="fulfillment-stat to-ship"><span>Open Orders</span><strong>{loading ? '--' : orders.length}</strong></article>
        <article className="fulfillment-stat in-transit"><span>Products</span><strong>{loading ? '--' : productPlan.length}</strong></article>
        <article className="fulfillment-stat delivered"><span>Total Units</span><strong>{loading ? '--' : totalUnits}</strong></article>
      </section>

      {loading ? <p className="status">Loading open orders...</p> : productPlan.length === 0 ? <p className="status">No open-order products to prepare.</p> : (
        <section className="ops-card fulfillment-plan-card">
          <div className="ops-card-header">
            <div>
              <h3>Production / Packing Plan</h3>
              <p className="muted compact">Make or gather these quantities to fulfill all current open orders.</p>
            </div>
            <span className="ops-mode-chip">{totalUnits} units</span>
          </div>
          <div className="orders-table-wrap">
            <table className="orders-table">
              <thead><tr><th>Product</th><th>Quantity Needed</th><th>Open Orders</th><th>Progress</th></tr></thead>
              <tbody>
                {productPlan.map((item) => (
                  <tr key={item.product}>
                    <td><strong>{item.product}</strong></td>
                    <td><span className="package-pill">{item.quantity} unit(s)</span></td>
                    <td>{item.orderCount}</td>
                    <td><div className="fulfillment-bar-track"><div className="fulfillment-bar to-ship" style={{ width: `${Math.max(4, (item.quantity / totalUnits) * 100)}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  )
}

function ShipmentScannerPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const scanLockRef = useRef(false)
  const [trackingNumber, setTrackingNumber] = useState('')
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const lookupTracking = useCallback(async (value: string) => {
    const normalized = value.trim()
    if (!normalized) {
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/scan/lookup?trackingNumber=${encodeURIComponent(normalized)}`)
      const payload = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !payload.order) {
        throw new Error(payload.message ?? 'No order found for this tracking number.')
      }
      setOrder(payload.order)
    } catch (requestError) {
      setOrder(null)
      setError(requestError instanceof Error ? requestError.message : 'Shipment lookup failed.')
    } finally {
      setLoading(false)
      scanLockRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    const reader = new BrowserMultiFormatReader()
    const videoElement = videoRef.current
    void reader.decodeFromVideoDevice(undefined, videoElement, (result, _error, controls) => {
      controlsRef.current = controls
      if (result && !scanLockRef.current) {
        scanLockRef.current = true
        const value = result.getText()
        setTrackingNumber(value)
        void lookupTracking(value)
      }
    }).catch((cameraRequestError: unknown) => {
      setCameraError(cameraRequestError instanceof Error ? cameraRequestError.message : 'Camera access is unavailable.')
    })

    return () => {
      controlsRef.current?.stop()
    }
  }, [lookupTracking])

  return (
    <main className="dashboard ops-page scanner-page">
      <section className="ops-topbar">
        <div>
          <p className="eyebrow">Amazon Fulfillment</p>
          <h1>Scan Shipment</h1>
          <p className="subtitle">Scan an Amazon label barcode to find its Shopify order.</p>
        </div>
        <div className="ops-top-actions">
          <button className="filter-button" onClick={() => navigate('/fulfillment')}>Fulfillment</button>
          <button className="filter-button" onClick={() => navigate('/')}>Orders</button>
        </div>
      </section>

      {cameraError ? <p className="error-banner">Camera unavailable: {cameraError}. Enter the tracking number manually below.</p> : null}
      {error ? <p className="error-banner">{error}</p> : null}

      <section className="scanner-layout">
        <article className="ops-card scanner-card">
          <h3>Scan label barcode</h3>
          <video ref={videoRef} className="scanner-video" muted playsInline />
          <label className="scanner-manual-input">
            Tracking number
            <input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} placeholder="Scan or type tracking number" />
          </label>
          <button className="sync-button" disabled={loading || !trackingNumber.trim()} onClick={() => void lookupTracking(trackingNumber)}>
            {loading ? 'Looking up...' : 'Find Shipment'}
          </button>
        </article>

        <article className="ops-card scanner-result-card">
          <h3>Shipment result</h3>
          {!order ? <p className="muted">Scan a label to see the linked order and products.</p> : (
            <>
              <div className="scanner-order-heading">
                <strong>{order.name}</strong>
                <span className={`status-pill ${getOrderStatusMeta(order.fulfillmentStatus).className}`}>{getOrderStatusMeta(order.fulfillmentStatus).label}</span>
              </div>
              <p><strong>Tracking:</strong> {order.fulfillmentTrackingNumber ?? trackingNumber}</p>
              <p><strong>Customer:</strong> {order.shippingAddress?.name ?? '--'}</p>
              <h4>Products and quantities</h4>
              <ul className="scanner-product-list">
                {order.lineItems.map((item, index) => <li key={`${item.title}-${index}`}>{item.title} <strong>x {item.quantity}</strong></li>)}
              </ul>
              <button className="sync-button" onClick={() => navigate(`/orders/${getLegacyOrderId(order.id)}`)}>Open Shopify Order</button>
            </>
          )}
        </article>
      </section>
    </main>
  )
}

function OrderDetailsPage() {
  const { legacyId } = useParams<{ legacyId: string }>()
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [fulfillmentAddress, setFulfillmentAddress] = useState<ShippingAddress | null>(null)
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
  const [previousAwb, setPreviousAwb] = useState<GeneratedShipment | null>(null)
  const [showExistingAwbChoice, setShowExistingAwbChoice] = useState(false)
  const [editingAddress, setEditingAddress] = useState(false)
  const [savingAddress, setSavingAddress] = useState(false)
  const [savingPackage, setSavingPackage] = useState(false)
  const [savingPaymentStatus, setSavingPaymentStatus] = useState(false)
  const [resettingFulfillment, setResettingFulfillment] = useState(false)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [showInvoiceFulfillmentForm, setShowInvoiceFulfillmentForm] = useState(false)
  const [invoiceFulfillmentForm, setInvoiceFulfillmentForm] = useState<InvoiceFulfillmentForm>({
    carrier: '',
    service: '',
    trackingNumber: ''
  })
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

  const loadFulfillmentAddress = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/fulfillment-address')
      const payload = (await response.json()) as FulfillmentAddressResponse
      if (!response.ok) {
        throw new Error('Failed to load fulfillment address.')
      }

      setFulfillmentAddress(payload.fulfillmentAddress)
    } catch {
      setFulfillmentAddress(null)
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

  const saveFulfillmentDetails = useCallback(async (packageProfileIdOverride?: string) => {
    const packageProfileId = packageProfileIdOverride || selectedPackageProfileId || defaultPackage?.id
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

        setShipment(null)
        setShipmentAlreadyExists(false)
        setShowExistingAwbChoice(false)

        await Promise.all([loadDefaultPackage(), loadFulfillmentAddress()])
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
  }, [legacyId, loadDefaultPackage, loadFulfillmentAddress])

  const printCurrentOrderInvoice = useCallback((invoiceFulfillment?: InvoiceFulfillmentForm) => {
    if (!order) {
      setError('Order details not available for invoice.')
      return
    }

    const invoiceOrder = invoiceFulfillment
      ? {
          ...order,
          fulfillmentCarrier: invoiceFulfillment.carrier.trim(),
          fulfillmentService: invoiceFulfillment.service.trim(),
          fulfillmentTrackingNumber: invoiceFulfillment.trackingNumber.trim()
        }
      : order
    const html = buildInvoiceHtml([invoiceOrder], HARD_CODED_INVOICE_COMPANY)
    const printWindow = window.open('', '_blank', 'width=1000,height=900')
    if (!printWindow) {
      setError('Unable to open print window. Please allow popups for this site.')
      return
    }

    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
  }, [order])

  const handleInvoiceRequest = useCallback(() => {
    if (!order) {
      setError('Order details not available for invoice.')
      return
    }

    if (order.fulfillmentTrackingNumber?.trim()) {
      printCurrentOrderInvoice()
      return
    }

    setInvoiceFulfillmentForm({
      carrier: order.fulfillmentCarrier ?? order.bestRateCarrier ?? '',
      service: order.fulfillmentService ?? order.bestRateService ?? '',
      trackingNumber: ''
    })
    setShowInvoiceFulfillmentForm(true)
  }, [order, printCurrentOrderInvoice])

  const submitInvoiceFulfillment = useCallback(() => {
    if (!invoiceFulfillmentForm.carrier.trim() || !invoiceFulfillmentForm.service.trim() || !invoiceFulfillmentForm.trackingNumber.trim()) {
      setError('Enter the fulfillment carrier, service, and AWB / tracking number to generate the invoice.')
      return
    }

    setShowInvoiceFulfillmentForm(false)
    printCurrentOrderInvoice(invoiceFulfillmentForm)
  }, [invoiceFulfillmentForm, printCurrentOrderInvoice])

  const useExistingAwb = useCallback(() => {
    const existingAwb = previousAwb ?? (order?.fulfillmentTrackingNumber ? {
      shipmentId: order.id,
      trackingId: order.fulfillmentTrackingNumber,
      carrier: order.fulfillmentCarrier ?? order.bestRateCarrier ?? 'Shopify carrier',
      service: order.fulfillmentService ?? order.bestRateService ?? 'Shipping service',
      shippingCost: order.fulfillmentShippingCost ?? order.bestRateAmount ?? 0,
      currencyCode: order.fulfillmentCurrency ?? order.bestRateCurrency ?? order.currencyCode,
      labelUrl: order.fulfillmentLabelUrl ?? '',
      collectAmount: order.paymentPending ? order.amountToCollect : '0.00'
    } : null)
    if (!existingAwb || !legacyId) {
      return
    }

    const selectExisting = async () => {
      if (previousAwb) {
        const response = await fetch(`/api/orders/${legacyId}/fulfillment/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackingNumber: existingAwb.trackingId, carrier: existingAwb.carrier })
        })
        const payload = (await response.json()) as { order?: OrderSummary; message?: string }
        if (!response.ok || !payload.order) {
          setError(payload.message ?? 'The previous AWB could not be attached to Shopify.')
          return
        }
        setOrder(payload.order)
      }

      setShipment(existingAwb)
      setShipmentAlreadyExists(true)
      setPreviousAwb(null)
      setShowExistingAwbChoice(false)
      setSuccess(`AWB selected: ${existingAwb.trackingId}`)
    }

    void selectExisting()
  }, [legacyId, order, previousAwb])

  const generateLabel = useCallback(async (regenerateExisting = false) => {
    if (!legacyId) {
      setError('Invalid order id.')
      return
    }

    if ((order?.fulfillmentTrackingNumber || previousAwb) && !regenerateExisting) {
      setShowExistingAwbChoice(true)
      return
    }

    if (order?.fulfillmentTrackingNumber && regenerateExisting) {
      setResettingFulfillment(true)
      try {
        const resetResponse = await fetch(`/api/orders/${legacyId}/fulfillment`, { method: 'DELETE' })
        const resetPayload = (await resetResponse.json()) as { order?: OrderSummary; message?: string }
        if (!resetResponse.ok || !resetPayload.order) {
          if (resetPayload.order) {
            setOrder(resetPayload.order)
          }
          setError(resetPayload.message ?? 'The existing Shopify fulfillment could not be cancelled.')
          return
        }
        setOrder(resetPayload.order)
        setShowExistingAwbChoice(false)
      } finally {
        setResettingFulfillment(false)
      }
    }

    if (previousAwb && regenerateExisting) {
      setPreviousAwb(null)
      setShowExistingAwbChoice(false)
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
        body: JSON.stringify({
          selectedRateId: selectedRateId || undefined,
          forceNew: regenerateExisting
        })
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
      setSuccess(payload.alreadyExists ? 'Existing shipment loaded.' : 'New label generated and attached.')
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
  }, [legacyId, order, previousAwb, selectedRateId])

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

  const resetFulfillment = useCallback(async () => {
    if (!legacyId || !order) {
      return
    }

    const confirmed = window.confirm(
      'Delete the AWB and local fulfillment details for this order? This removes the stored label and allows a new label to be generated.'
    )
    if (!confirmed) {
      return
    }

    setResettingFulfillment(true)
    setError(null)
    try {
      const response = await fetch(`/api/orders/${legacyId}/fulfillment`, { method: 'DELETE' })
      const payload = (await response.json()) as {
        order?: OrderSummary
        message?: string
        alreadyFulfilled?: boolean
        previousAwb?: {
          trackingNumber: string | null
          carrier: string | null
          service: string | null
          labelUrl: string | null
          shippingCost: number
          currencyCode: string
          collectAmount: string
        }
      }
      if (response.status === 409 && payload.alreadyFulfilled && payload.order) {
        setOrder(payload.order)
        setSuccess(payload.message ?? 'This order is already fulfilled in Shopify.')
        return
      }
      if (!response.ok || !payload.order) {
        throw new Error(payload.message ?? 'Failed to reset fulfillment details.')
      }

      setOrder(payload.order)
      setPreviousAwb(payload.previousAwb?.trackingNumber ? {
        shipmentId: payload.order.id,
        trackingId: payload.previousAwb.trackingNumber,
        carrier: payload.previousAwb.carrier ?? 'Amazon Shipping',
        service: payload.previousAwb.service ?? 'Shipping service',
        shippingCost: payload.previousAwb.shippingCost,
        currencyCode: payload.previousAwb.currencyCode,
        labelUrl: payload.previousAwb.labelUrl ?? '',
        collectAmount: payload.previousAwb.collectAmount
      } : null)
      setShipment(null)
      setShipmentAlreadyExists(false)
      setOrderRates([])
      setSelectedRateId('')
      setSuccess(payload.message ?? 'Fulfillment details reset.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to reset fulfillment details.')
    } finally {
      setResettingFulfillment(false)
    }
  }, [legacyId, order])

  const syncAwbFromShopify = useCallback(async () => {
    if (!legacyId) {
      return
    }

    setError(null)
    try {
      const response = await fetch(`/api/orders/${legacyId}`)
      const payload = (await response.json()) as { order?: OrderSummary; message?: string }
      if (!response.ok || !payload.order) {
        throw new Error(payload.message ?? 'Failed to sync AWB details from Shopify.')
      }

      setOrder(payload.order)
      setShipment(null)
      setShipmentAlreadyExists(false)
      setShowExistingAwbChoice(false)
      setSuccess(payload.order.fulfillmentTrackingNumber
        ? `AWB synced from Shopify: ${payload.order.fulfillmentTrackingNumber}`
        : 'Shopify has no AWB for this order.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to sync AWB details from Shopify.')
    }
  }, [legacyId])

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
          {showExistingAwbChoice && (order.fulfillmentTrackingNumber || previousAwb) ? (
            <section className="ops-card existing-awb-choice">
              <div>
                <h3>{previousAwb ? 'Previous AWB available' : 'Existing Shopify AWB found'}</h3>
                <p>
                  AWB <strong>{previousAwb?.trackingId ?? order.fulfillmentTrackingNumber}</strong>
                  {(previousAwb?.carrier ?? order.fulfillmentCarrier) ? ` | ${previousAwb?.carrier ?? order.fulfillmentCarrier}` : ''}
                </p>
                <p className="muted compact">Choose the previous AWB or create a fresh Amazon shipment and attach it to Shopify.</p>
              </div>
              <div className="existing-awb-actions">
                <button className="filter-button" onClick={useExistingAwb}>
                  {previousAwb ? 'Reuse Previous AWB' : 'Use Existing AWB'}
                </button>
                <button className="sync-button" disabled={resettingFulfillment || generatingLabel} onClick={() => void generateLabel(true)}>
                  Generate Fresh Label
                </button>
              </div>
            </section>
          ) : null}
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
              <button className="filter-button" onClick={handleInvoiceRequest}>
                Generate Invoice
              </button>
              {order.id.startsWith('gid://store/ManualOrder/') && order.fulfillmentStatus !== 'CANCELLED' && !order.fulfillmentLabelUrl ? (
                <button className="filter-button" disabled={cancellingOrder || generatingLabel} onClick={() => void cancelManualOrder()}>
                  {cancellingOrder ? 'Cancelling...' : 'Cancel Manual Order'}
                </button>
              ) : null}
              <button
                className="sync-button"
                disabled={generatingLabel || resettingFulfillment || order.fulfillmentStatus === 'CANCELLED'}
                title={order.fulfillmentTrackingNumber ? 'Choose whether to use the existing AWB or generate a fresh label.' : undefined}
                onClick={() => void generateLabel()}
              >
                {generatingLabel
                  ? 'Generating Label...'
                  : order.fulfillmentTrackingNumber
                    ? 'Choose AWB'
                    : 'Generate Label'}
              </button>
              <button
                className="filter-button danger-action"
                disabled={resettingFulfillment || generatingLabel}
                onClick={() => void resetFulfillment()}
              >
                {resettingFulfillment ? 'Checking...' : 'Delete AWB / Reset'}
              </button>
              <button
                className="filter-button"
                disabled={resettingFulfillment || generatingLabel}
                onClick={() => void syncAwbFromShopify()}
              >
                Sync AWB from Shopify
              </button>
            </div>
          </section>

          <section className="details-ops-grid">
            <div className="details-left-col">
              <article className="ops-card">
                <div className="ops-card-inline">
                  <p>
                    Fulfilled from{' '}
                    <strong>{fulfillmentAddress?.name ?? fulfillmentAddress?.address1 ?? 'Configured fulfillment address'}</strong>
                  </p>
                </div>
                <p className="muted compact">{addressToText(fulfillmentAddress)}</p>
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
                      onChange={(event) => {
                        setSelectedPackageProfileId(event.target.value)
                        void saveFulfillmentDetails(event.target.value)
                      }}
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

          {showInvoiceFulfillmentForm ? (
            <section className="details-modal-backdrop" role="dialog" aria-modal="true" aria-label="Enter invoice fulfillment details">
              <div className="details-modal-sheet invoice-fulfillment-modal">
                <div className="details-modal-body">
                  <h2>Fulfillment Details Required</h2>
                  <p className="muted">
                    This order has no AWB / tracking number. Enter the shipment details to include them on the invoice.
                  </p>
                  <div className="field-grid">
                    <label>
                      Carrier <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={invoiceFulfillmentForm.carrier}
                        onChange={(event) => setInvoiceFulfillmentForm((current) => ({ ...current, carrier: event.target.value }))}
                        placeholder="Amazon Shipping or another carrier"
                        autoFocus
                      />
                    </label>
                    <label>
                      Service <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={invoiceFulfillmentForm.service}
                        onChange={(event) => setInvoiceFulfillmentForm((current) => ({ ...current, service: event.target.value }))}
                        placeholder="Standard, Express, etc."
                      />
                    </label>
                    <label>
                      AWB / Tracking Number <span className="required-mark">*</span>
                      <input
                        type="text"
                        value={invoiceFulfillmentForm.trackingNumber}
                        onChange={(event) => setInvoiceFulfillmentForm((current) => ({ ...current, trackingNumber: event.target.value }))}
                        placeholder="Enter AWB or tracking number"
                      />
                    </label>
                  </div>
                </div>
                <div className="details-modal-footer">
                  <button className="modal-link-button" type="button" onClick={() => setShowInvoiceFulfillmentForm(false)}>
                    Cancel
                  </button>
                  <button className="modal-link-button save" type="button" onClick={submitInvoiceFulfillment}>
                    Generate Invoice
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
      <Route path="/gst-work" element={<GstWorkPage />} />
      <Route path="/fulfillment" element={<FulfillmentDashboardPage />} />
      <Route path="/fulfillment-plan" element={<FulfillmentPlanPage />} />
      <Route path="/scan" element={<ShipmentScannerPage />} />
      <Route path="/orders/:legacyId" element={<OrderDetailsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  )
}

export default App
