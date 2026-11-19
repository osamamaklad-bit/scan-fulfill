/**
 * Returns support for Scan to Fulfill (server side, Google Apps Script).
 *
 * The phone app's Returns mode calls two new actions:
 *   getReturnable  { query: "1234" }  -> { ok, order: {id, name}, items: [...] }
 *   processReturn  { orderId, items: [{fliId, qty, locationId}], reason, restock, notify }
 *                                     -> { ok, returnName }
 *
 * Setup
 *  1. Add this file to your existing Apps Script project.
 *  2. In your doPost, after the app key check, route the two actions, e.g.
 *       if (body.action === 'getReturnable') return out(getReturnable_(body));
 *       if (body.action === 'processReturn') return out(processReturn_(body));
 *     (use whatever helper your doPost already uses to send JSON back).
 *  3. Your Shopify app/token needs the scopes read_returns and write_returns
 *     (plus read_orders, read_fulfillments, read_locations it most likely has).
 *  4. returnsGql_ below reads the Script Properties SHOPIFY_STORE and SHOPIFY_TOKEN.
 *     If your script already has a GraphQL helper, make returnsGql_ call that instead.
 *
 * Refunds are deliberately NOT issued here: the return is created (and items
 * restocked if asked), and the money is refunded from the order in Shopify admin.
 */

const RETURNS_API_VERSION = '2025-01';

function returnsGql_(query, variables) {
  const props = PropertiesService.getScriptProperties();
  const shop = props.getProperty('SHOPIFY_STORE');   // e.g. my-store.myshopify.com
  const token = props.getProperty('SHOPIFY_TOKEN');
  const res = UrlFetchApp.fetch('https://' + shop + '/admin/api/' + RETURNS_API_VERSION + '/graphql.json', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (data.errors) {
    throw new Error('Shopify: ' + (Array.isArray(data.errors) ? data.errors.map(function (e) { return e.message; }).join('; ') : data.errors));
  }
  return data.data;
}

function userErrors_(errs) {
  if (errs && errs.length) throw new Error(errs.map(function (e) { return e.message; }).join('; '));
}

/** Fulfilled items on an order that can still be returned. */
function getReturnable_(body) {
  const num = String(body.query || '').replace(/[^0-9a-z]/gi, '');
  if (!num) throw new Error('Missing order number');

  const found = returnsGql_(
    'query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }',
    { q: 'name:#' + num + ' OR name:' + num }
  );
  const order = found.orders.nodes[0];
  if (!order) throw new Error('Order ' + num + ' not found');

  const data = returnsGql_(
    'query($id: ID!) {' +
    '  returnableFulfillments(orderId: $id, first: 25) { nodes {' +
    '    fulfillment { location { id } }' +
    '    returnableFulfillmentLineItems(first: 100) { nodes {' +
    '      quantity' +
    '      fulfillmentLineItem { id lineItem { title sku image { url } variant { barcode sku } } }' +
    '    } }' +
    '  } }' +
    '}',
    { id: order.id }
  );

  const items = [];
  data.returnableFulfillments.nodes.forEach(function (rf) {
    const locationId = rf.fulfillment && rf.fulfillment.location ? rf.fulfillment.location.id : '';
    rf.returnableFulfillmentLineItems.nodes.forEach(function (n) {
      if (!n.quantity) return;
      const li = n.fulfillmentLineItem.lineItem || {};
      const v = li.variant || {};
      items.push({
        fliId: n.fulfillmentLineItem.id,
        locationId: locationId,
        title: li.title || 'Item',
        sku: v.sku || li.sku || '',
        barcode: v.barcode || '',
        image: li.image ? li.image.url : '',
        need: n.quantity            // how many can be returned
      });
    });
  });

  return { ok: true, order: { id: order.id, name: order.name }, items: items };
}

/** Creates the return in Shopify and (optionally) restocks the items. */
function processReturn_(body) {
  const items = (body.items || []).filter(function (i) { return i.fliId && i.qty > 0; });
  if (!body.orderId || !items.length) throw new Error('Nothing to return');
  const reason = body.reason || 'UNKNOWN';

  const created = returnsGql_(
    'mutation($input: ReturnInput!) {' +
    '  returnCreate(returnInput: $input) {' +
    '    return { id name reverseFulfillmentOrders(first: 10) { nodes {' +
    '      lineItems(first: 100) { nodes { id totalQuantity fulfillmentLineItem { id } } }' +
    '    } } }' +
    '    userErrors { field message }' +
    '  }' +
    '}',
    {
      input: {
        orderId: body.orderId,
        notifyCustomer: !!body.notify,
        returnLineItems: items.map(function (i) {
          return { fulfillmentLineItemId: i.fliId, quantity: Number(i.qty), returnReason: reason };
        })
      }
    }
  );
  userErrors_(created.returnCreate.userErrors);
  const ret = created.returnCreate.return;

  if (body.restock) {
    const locByFli = {};
    items.forEach(function (i) { locByFli[i.fliId] = i.locationId; });
    let fallbackLoc = null;
    const inputs = [];
    ret.reverseFulfillmentOrders.nodes.forEach(function (rfo) {
      rfo.lineItems.nodes.forEach(function (li) {
        let loc = li.fulfillmentLineItem && locByFli[li.fulfillmentLineItem.id];
        if (!loc) loc = fallbackLoc || (fallbackLoc = defaultLocation_());
        inputs.push({
          reverseFulfillmentOrderLineItemId: li.id,
          quantity: li.totalQuantity,
          dispositionType: 'RESTOCKED',
          locationId: loc
        });
      });
    });
    if (inputs.length) {
      const disp = returnsGql_(
        'mutation($d: [ReverseFulfillmentOrderDisposeInput!]!) {' +
        '  reverseFulfillmentOrderDispose(dispositionInputs: $d) { userErrors { field message } }' +
        '}',
        { d: inputs }
      );
      // The return already exists at this point, so say so if restocking fails
      try { userErrors_(disp.reverseFulfillmentOrderDispose.userErrors); }
      catch (e) { throw new Error('Return ' + ret.name + ' was created, but restocking failed: ' + e.message); }
    }
  }

  return { ok: true, returnName: ret.name };
}

function defaultLocation_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHOPIFY_LOCATION_ID');
  if (id) return id;
  const d = returnsGql_('{ locations(first: 1) { nodes { id } } }');
  if (!d.locations.nodes.length) throw new Error('No Shopify location found for restocking');
  return d.locations.nodes[0].id;
}
