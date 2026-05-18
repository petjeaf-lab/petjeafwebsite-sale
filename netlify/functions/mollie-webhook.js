// ============================================================
// Netlify Function: mollie-webhook
// Mollie roept dit endpoint aan zodra een betaling van status verandert.
// Wij halen de betaling op met de API en sturen een melding naar Formspree
// zodat jij per mail ziet of de betaling gelukt / mislukt is.
// ============================================================
//
// Mollie security: webhook body bevat alleen { id: "tr_xxx" }.
// Wij MOETEN de status zelf opvragen via de Mollie API om vervalste calls te voorkomen.
//
// Vereiste environment variables:
//   MOLLIE_API_KEY     = zoals in create-payment.js
//   FORMSPREE_NOTIFY   = (optioneel) Formspree endpoint dat de notificatie ontvangt.
//                        Default: hetzelfde formulier als de order — pas aan als gewenst.
// ============================================================

const DEFAULT_FORMSPREE = 'https://formspree.io/f/mdabrowv';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.MOLLIE_API_KEY;
  if (!apiKey) {
    console.error('MOLLIE_API_KEY ontbreekt');
    return { statusCode: 500, body: 'Server config error' };
  }

  // Mollie stuurt form-urlencoded: id=tr_xxx
  const params = new URLSearchParams(event.body || '');
  const paymentId = params.get('id');
  if (!paymentId) {
    return { statusCode: 400, body: 'Missing payment id' };
  }

  // Haal de betaling op bij Mollie
  let payment;
  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    payment = await r.json();
    if (!r.ok) {
      console.error('Mollie payment fetch faalde', r.status, payment);
      return { statusCode: 200, body: 'OK' }; // 200 zodat Mollie niet eindeloos retried
    }
  } catch (err) {
    console.error('Mollie fetch error', err);
    return { statusCode: 200, body: 'OK' };
  }

  // Mail jezelf een statusupdate via Formspree
  const notifyEndpoint = process.env.FORMSPREE_NOTIFY || DEFAULT_FORMSPREE;
  const meta = payment.metadata || {};

  const statusLabel =
    payment.status === 'paid' ? '✅ BETAALD' :
    payment.status === 'failed' ? '❌ MISLUKT' :
    payment.status === 'canceled' ? '✋ GEANNULEERD' :
    payment.status === 'expired' ? '⏰ VERLOPEN' :
    `(${payment.status})`;

  const notifyBody = {
    _subject: `Betaalstatus ${statusLabel} — ${meta.naam || 'onbekend'}`,
    status: payment.status,
    bedrag: payment.amount && `€${payment.amount.value}`,
    methode: payment.method || '(onbekend)',
    payment_id: payment.id,
    klant_naam: meta.naam,
    klant_email: meta.email,
    klant_adres: meta.adres,
    aantal: meta.aantal,
    opmerking: meta.opmerking,
    modus: meta.modus,
    paidAt: payment.paidAt,
  };

  try {
    await fetch(notifyEndpoint, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(notifyBody),
    });
  } catch (err) {
    console.warn('Formspree notify mislukt (niet fataal)', err);
  }

  // Altijd 200 terug — Mollie eist een 2xx anders blijft 'ie retryen.
  return { statusCode: 200, body: 'OK' };
};
