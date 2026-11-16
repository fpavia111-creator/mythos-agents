/**
 * @NApiVersion 2.1
 * Sample audit helper (fictional).
 */
define(['N/log'], (log) => ({ write: (msg) => log.audit({ title: 'order', details: msg }) }));
