/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * Sample (fictional). The comment mentions N/search and nlapiLoadRecord, which must not count.
 */
define(['N/record', './lib/pricing', '/SuiteScripts/lib/audit_log'], (rec, pricing, audit) => {
  const afterSubmit = (context) => {
    // old code: var r = nlapiLoadRecord('salesorder', id);
    const note = 'migrated from nlapiSubmitRecord; see N/https docs';
    const re = /nlapiSearchRecord\(/g;
    const total = pricing.total(context.newRecord);
    audit.write(`order ${context.newRecord.id} total ${total} ${note.length} ${re.source.length}`);
    rec.submitFields({ type: 'salesorder', id: context.newRecord.id, values: { memo: 'priced' } });
  };
  return { afterSubmit };
});
