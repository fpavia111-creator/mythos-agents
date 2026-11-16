// Exports Soteria reads directly. A file already in Soteria's own columns is read as it is.
import { exportProfile, firstRowPer } from 'mythos-agent-core';

const orderRef = { from: ['order_id (metadata)', 'Order ID (metadata)', 'order (metadata)', 'Invoice ID', 'id'], compute: (_r, get) => ['order_id (metadata)', 'Order ID (metadata)', 'order (metadata)', 'Invoice ID', 'id'].map((k) => String(get(k) ?? '').trim()).find(Boolean) || '' };
const STRIPE_ORDER_NOTE = 'A Stripe payment has no order number of its own. The order id is read from an "order_id (metadata)" column when the export has one, then the invoice id, then the charge id. Requests must use the same id.';

const REQUEST_FIELDS = {
  request_id: { aliases: ['Request ID', 'Case ID', 'Dispute ID', 'Ticket ID', 'Return ID', 'RMA'] },
  type: { aliases: ['Type', 'Channel', 'Kind', 'Case Type'] },
  order_id: { aliases: ['Order ID', 'Order', 'Order Number', 'Order No', 'Order #'], required: true },
  customer: { type: 'email', aliases: ['Customer', 'Customer Email', 'Email', 'Buyer Email'] },
  amount: { type: 'money', aliases: ['Requested Amount', 'Refund Amount', 'Dispute Amount', 'Disputed Amount'] },
  reason: { aliases: ['Reason', 'Return Reason', 'Refund Reason', 'Dispute Reason', 'Category'] },
  reason_code: { aliases: ['Reason Code', 'Network Reason Code', 'Dispute Reason Code'] },
  network: { aliases: ['Network', 'Card Brand', 'Card Network', 'Scheme'] },
  requested_at: { type: 'date', aliases: ['Requested At', 'Request Date', 'Created At', 'Opened', 'Dispute Date', 'Date'] },
  returned: { type: 'bool', aliases: ['Returned', 'Return Received', 'Item Returned'] },
};
const ORDER_FIELDS = {
  order_id: { aliases: ['Order ID', 'Order', 'Order Number', 'Order No', 'Order #'], required: true },
  customer: { type: 'email', aliases: ['Customer', 'Customer Email', 'Email', 'Buyer Email'] },
  amount: { type: 'money', aliases: ['Total', 'Order Total', 'Grand Total', 'Amount Paid'], required: true },
  refunded: { type: 'money', aliases: ['Refunded', 'Refunded Amount', 'Amount Refunded', 'Total Refunded'] },
  order_date: { type: 'date', aliases: ['Order Date', 'Created At', 'Date', 'Placed On', 'Purchase Date'] },
  delivered_date: { type: 'date', aliases: ['Delivered Date', 'Delivered At', 'Delivered', 'Delivery Date'] },
  tracking: { aliases: ['Tracking', 'Tracking Number', 'Tracking No', 'Tracking Code'] },
  status: { aliases: ['Order Status', 'Fulfillment Status', 'Shipment Status'] },
};

export const SOURCES = {
  requests: {
    label: 'Refund requests and chargebacks', fields: REQUEST_FIELDS,
    profiles: [
      exportProfile('stripe_payments', {
        request_id: { from: ['id'], consume: false, compute: (_r, get) => `dispute-${String(get('id') ?? '').trim()}` },
        type: { value: 'chargeback' },
        order_id: orderRef,
        customer: 'Customer Email',
        amount: 'Disputed Amount',
        reason: { from: 'Dispute Reason', transform: (v) => String(v).replace(/_/g, ' ') },
        network: ['Card Brand', 'Card Network'],
        requested_at: ['Dispute Date (UTC)', 'Dispute Created (UTC)'],
      }, { signature: ['id', 'Disputed Amount', 'Dispute Reason'], skipRow: (_r, get) => !String(get('Dispute Status') ?? get('Dispute Reason') ?? '').trim(), note: `Only payments with a dispute are read as requests. Stripe gives its own reason words, not the card network's reason code. ${STRIPE_ORDER_NOTE}` }),
    ],
  },
  orders: {
    label: 'Orders', fields: ORDER_FIELDS,
    profiles: [
      exportProfile('shopify_orders', {
        order_id: 'Name',
        customer: 'Email',
        amount: 'Total',
        refunded: { from: 'Refunded Amount', default: '0' },
        order_date: ['Created at', 'Paid at'],
        status: 'Fulfillment Status',
      }, { rows: firstRowPer('order_id'), note: 'The Shopify orders export has no delivery date and no tracking number. Refund windows run from the order date for this file, and "not received" claims show as having no tracking. Shopify repeats an order once per line item; the first row carries the totals and is the one read.' }),
      exportProfile('stripe_payments', {
        order_id: orderRef,
        customer: 'Customer Email',
        amount: 'Amount',
        refunded: { from: 'Amount Refunded', default: '0' },
        order_date: ['Created date (UTC)', 'Created (UTC)'],
        status: { from: 'Status', transform: (v) => String(v).toLowerCase() },
      }, { note: `Stripe has no delivery date or tracking number, so refund windows run from the payment date. ${STRIPE_ORDER_NOTE}` }),
    ],
  },
};
