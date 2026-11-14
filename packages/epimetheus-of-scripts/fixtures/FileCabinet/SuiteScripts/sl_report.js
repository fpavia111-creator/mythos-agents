/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget'], function (ui) {
  function onRequest(context) {
    var form = ui.createForm({ title: 'Sample report' });
    context.response.writePage(form);
  }
  return { onRequest: onRequest };
});
