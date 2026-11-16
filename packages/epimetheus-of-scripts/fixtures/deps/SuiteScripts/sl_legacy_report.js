/**
 * Sample SuiteScript 1.0 Suitelet (fictional). Mixes real calls with text that only looks like calls.
 */
function suitelet(request, response) {
  var title = "nlapiCreateForm is the old way";
  var form = nlapiCreateForm('Legacy report');
  var tmpl = `nlapiSendEmail ${nlapiGetUser()}`;
  nlapiSetRecoveryPoint();
  response.writePage(form);
  require(['./lib/missing_helper'], function (helper) { helper.run(title, tmpl); });
}
