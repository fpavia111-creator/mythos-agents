/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], function (currentRecord) {
  function fieldChanged(context) {
    var rec = context.currentRecord;
    if (context.fieldId === 'companyname') rec.setValue({ fieldId: 'printoncheckas', value: rec.getValue('companyname') });
  }
  return { fieldChanged: fieldChanged };
});
