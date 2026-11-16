// Exports Hesperides reads directly. A file already in Hesperides's own columns is read as it is.
import { exportProfile } from 'mythos-agent-core';

const ON_HAND_FIELDS = {
  sku: { aliases: ['SKU', 'Item', 'Item ID', 'Item Number', 'Item Code', 'Part Number', 'Product Code'], required: true },
  location: { aliases: ['Bin', 'Warehouse', 'Bin Number', 'Inventory Location', 'Site'] },
  description: { aliases: ['Display Name', 'Item Description', 'Product Name', 'Title'] },
  system_qty: { type: 'number', aliases: ['On Hand', 'Quantity On Hand', 'Qty On Hand', 'Location On Hand', 'Quantity', 'Qty', 'Stock'], required: true },
  unit_cost: { type: 'money', aliases: ['Unit Cost', 'Cost', 'Average Cost', 'Avg Cost', 'Location Average Cost', 'Standard Cost'] },
  uom: { aliases: ['UOM', 'Unit', 'Units', 'Stock Unit', 'Unit of Measure'] },
  lot: { aliases: ['Lot', 'Lot Number', 'Batch', 'Inventory Number'] },
  expiry: { type: 'date', aliases: ['Expiry', 'Expiry Date', 'Expiration Date', 'Best Before'] },
};
const COUNT_FIELDS = {
  sku: { aliases: ['SKU', 'Item', 'Item ID', 'Item Number', 'Item Code', 'Part Number', 'Barcode'], required: true },
  location: { aliases: ['Bin', 'Warehouse', 'Bin Number', 'Site'] },
  counted_qty: { type: 'number', aliases: ['Counted Qty', 'Count', 'Counted', 'Count Qty', 'Physical Count', 'Quantity Counted'], required: true },
  recount_qty: { type: 'number', aliases: ['Recount Qty', 'Recount', 'Second Count'] },
  uom: { aliases: ['UOM', 'Unit', 'Units'] },
  counter: { aliases: ['Counter', 'Counted By', 'User', 'Operator'] },
  counted_at: { type: 'datetime', aliases: ['Counted At', 'Count Date', 'Count Time', 'Timestamp', 'Scanned At'] },
};

export const SOURCES = {
  on_hand: {
    label: 'System on-hand quantities', fields: ON_HAND_FIELDS,
    profiles: [
      exportProfile('netsuite_inventory', {
        sku: ['Name', 'Item'],
        location: ['Location', 'Inventory Location'],
        description: ['Display Name', 'Description'],
        system_qty: ['Location On Hand', 'On Hand'],
        unit_cost: ['Location Average Cost', 'Average Cost'],
        uom: ['Stock Unit', 'Units', 'Primary Stock Unit'],
      }),
      exportProfile('shopify_inventory', {
        sku: 'SKU',
        location: 'Location',
        description: 'Title',
        system_qty: ['On hand (current)', 'On hand', 'Available'],
      }, { skipRow: (_r, get) => !String(get('SKU') ?? '').trim(), note: 'The Shopify inventory export has no unit cost, so variances are shown in units and their value is unknown. Rows with no SKU are skipped.' }),
    ],
  },
  counts: { label: 'Count sheet', args: ['counts', 'previous_counts'], fields: COUNT_FIELDS, profiles: [] },
};
