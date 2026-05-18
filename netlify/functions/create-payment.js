// ============================================================
// Netlify Function: create-payment
// Maakt een Mollie betaling aan en geeft de checkout URL terug.
// De Mollie API key staat veilig in Netlify als environment variable.
// ============================================================
//
// Vereiste environment variables in Netlify (Site settings → Environment variables):
//   MOLLIE_API_KEY     = de live_ of test_ key uit het Studentenbedrijf dashboard
//   SITE_URL           = bijv. https://petjeaf.nl  (of je netlify .app URL)
//
// Route: POST /.netlify/functions/create-payment
// Body (JSON): { naam, email, adres, aantal, opmerking, modus, kortingscode? }
// ============================================================

// ====== KORTINGSCODES (SERVER-SIDE — leidend voor de echte prijs!) ======
// HOUD DEZE IN SYNC met de KORTINGSCODES in index.html.
// De server vertrouwt NOOIT de prijs uit de browser — die kan door
// iemand met dev-tools worden gewijzigd. Daarom recalculeren we hier
// het totaal op basis van: aantal × prijs_per_pet − korting.
const KORTINGSCODES = {
  'WELKOM10':  { type: 'fixed',   value: 10, label: '€10 welkomstkorting' },
  'STUDENT5':  { type: 'fixed',   value: 5,  label: '€5 studentenkorting' },
  'VRIEND15':  { type: 'percent', value: 15, label: '15% vriendenkorting' },
};

// Vaste prijs per cap in euro (geheel getal). Pas aan als je index.html prijs wijzigt.
const PRICE_EUR = 35;

// Minimum totaalbedrag dat we accepteren (Mollie staat €0 niet toe).
const MIN_TOTAL_EUR = 1;

exports.handler = async function (event) {
  // Alleen POST toestaan
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.MOLLIE_API_KEY;
  const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');

  if (!apiKey) {
    console.error('MOLLIE_API_KEY ontbreekt in Netlify environment variables');
    return json(500, { error: 'Betaaldienst is nog niet geconfigureerd. Neem contact op met de webshop.' });
  }
  if (!siteUrl) {
    console.error('SITE_URL ontbreekt in Netlify environment variables');
    return json(500, { error: 'SITE_URL ontbreekt in serverconfiguratie.' });
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Ongeldige JSON' });
  }

  // Valideer minimaal
  const aantal = parseInt(body.aantal, 10);
  if (!body.naam || !body.email || !body.adres || !aantal) {
    return json(400, { error: 'Vul alle velden in.' });
  }
  if (aantal < 1 || aantal > 50) {
    return json(400, { error: 'Aantal moet tussen 1 en 50 zijn.' });
  }

  // ====== PRIJS BEREKENEN — server-side, NIET vertrouwen op browser-input ======
  const subtotaal = aantal * PRICE_EUR;

  // Kortingscode valideren
  let korting = 0;
  let kortingscodeApplied = '';
  let kortingsLabel = '';
  const rawCode = (body.kortingscode || '').trim().toUpperCase();
  if (rawCode) {
    const def = KORTINGSCODES[rawCode];
    if (!def) {
      return json(400, { error: 'Onbekende kortingscode: ' + rawCode });
    }
    if (def.type === 'fixed') {
      korting = Math.min(def.value, subtotaal);
    } else if (def.type === 'percent') {
      korting = Math.round((subtotaal * def.value) / 100);
    }
    kortingscodeApplied = rawCode;
    kortingsLabel = def.label;
  }

  const totaalNum = Math.max(0, subtotaal - korting);
  if (totaalNum < MIN_TOTAL_EUR) {
    return json(400, { error: 'Totaalbedrag is te laag voor een betaling.' });
  }
  const totaal = totaalNum.toFixed(2);

  // Beschrijving voor in Mollie + jouw dashboard
  let beschrijving = `Petje Af cap × ${aantal} — ${body.naam}`;
  if (kortingscodeApplied) beschrijving += ` (code: ${kortingscodeApplied})`;

  // Mollie betaling aanmaken
  // Docs: https://docs.mollie.com/reference/v2/payments-api/create-payment
  const molliePayload = {
    amount: { currency: 'EUR', value: totaal },
    description: beschrijving.substring(0, 255),
    redirectUrl: `${siteUrl}/?betaling=voltooid&order=${encodeURIComponent(body.email)}`,
    webhookUrl: `${siteUrl}/.netlify/functions/mollie-webhook`,
    metadata: {
      naam: body.naam,
      email: body.email,
      adres: body.adres,
      aantal: aantal,
      opmerking: body.opmerking || '',
      modus: body.modus || '',
      subtotaal: subtotaal.toFixed(2),
      kortingscode: kortingscodeApplied,
      korting: korting.toFixed(2),
      totaal: totaal,
    },
  };

  let mollieResp;
  try {
    mollieResp = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(molliePayload),
    });
  } catch (err) {
    console.error('Mollie API call mislukte', err);
    return json(502, { error: 'Kon Mollie niet bereiken. Probeer opnieuw.' });
  }

  const mollieJson = await mollieResp.json().catch(() => ({}));

  if (!mollieResp.ok) {
    console.error('Mollie API gaf fout:', mollieResp.status, mollieJson);
    return json(502, {
      error: 'Mollie weigerde de betaling.',
      detail: mollieJson.detail || mollieJson.title || 'Onbekende fout',
    });
  }

  const checkoutUrl = mollieJson._links && mollieJson._links.checkout && mollieJson._links.checkout.href;
  if (!checkoutUrl) {
    console.error('Geen checkout URL in Mollie response', mollieJson);
    return json(502, { error: 'Geen betaalpagina terug van Mollie.' });
  }

  return json(200, {
    checkoutUrl: checkoutUrl,
    paymentId: mollieJson.id,
    // Voor de browser: laat zien wat we hebben toegepast (puur informatief)
    applied: {
      subtotaal: subtotaal,
      kortingscode: kortingscodeApplied,
      kortingsLabel: kortingsLabel,
      korting: korting,
      totaal: totaalNum,
    },
  });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
