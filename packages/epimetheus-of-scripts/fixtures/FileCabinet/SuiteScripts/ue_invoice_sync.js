/**
 * Sample SuiteScript 1.0 user event (fictional). Syncs invoices to an outside system.
 */
function afterSubmit(type) {
  if (type !== 'create' && type !== 'edit') return;
  var rec = nlapiGetNewRecord();
  var id = rec.getId();
  var inv = nlapiLoadRecord('invoice', id);
  var total = inv.getFieldValue('total');
  var payload = JSON.stringify({ id: id, total: total });
  var resp = nlapiRequestURL('https://example.invalid/sync', payload, { 'Content-Type': 'application/json' }, 'POST');
  if (resp.getCode() !== 200) {
    nlapiLogExecution('ERROR', 'sync failed', resp.getBody());
    nlapiSubmitField('invoice', id, 'custbody_sync_status', 'failed');
    nlapiSendEmail(-5, 'ap@example.invalid', 'Invoice sync failed', 'Invoice ' + id);
  }
}
