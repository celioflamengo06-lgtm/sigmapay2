const { getSupabase } = require("./lib/supabase");

const SLIMMPAY_BASE       = "https://api.slimmpay.com.br/v1";
const SLIMMPAY_PUBLIC_KEY = process.env.SLIMMPAY_PUBLIC_KEY;
const SLIMMPAY_SECRET_KEY = process.env.SLIMMPAY_SECRET_KEY;

function getAuthHeader() {
  const token = Buffer.from(`${SLIMMPAY_PUBLIC_KEY}:${SLIMMPAY_SECRET_KEY}`).toString("base64");
  return `Basic ${token}`;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function normalizeAmount(rawAmount) {
  if (rawAmount == null) return { amountReais: 37.20 };
  if (typeof rawAmount === "string") {
    const cleaned = rawAmount.replace(/[^\d,.-]/g, "").replace(",", ".");
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n)) return { amountReais: 37.20 };
    // Se vier em centavos (ex: 3720), converte
    if (Number.isInteger(n) && n >= 100) return { amountReais: n / 100 };
    return { amountReais: n };
  }
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return { amountReais: 37.20 };
  if (Number.isInteger(n) && n >= 100) return { amountReais: n / 100 };
  return { amountReais: n };
}

async function postWithRetry(url, payload, headers) {
  const delays = [1000, 2000, 4000];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.status >= 400 && resp.status < 500) return resp;
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  throw lastErr;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: "",
    };
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const randDigits = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
  const randId = randDigits(6);

  const rawAmount = body.amount ?? body.valor ?? body.total ?? 37.20;
  const { amountReais } = normalizeAmount(rawAmount);

  const customerName  = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@example.com`).toString().trim();
  const customerPhone = (body.phone || body.customer_phone || `11${randDigits(9)}`).toString().replace(/\D/g, "");
  const cpfRaw        = (body.cpf || body.document || body.customer_cpf || randDigits(11)).toString().replace(/\D/g, "");
  const customerCpf   = cpfRaw.padEnd(11, "0").slice(0, 11);

  const externalId = `${randId}-${Date.now()}`;

  const amountCents = Math.round(amountReais * 100);

  const payload = {
    payment_method: "pix",
    amount: amountCents,
    external_id: externalId,
    items: [{ title: "Livro Falante", quantity: 1, unit_price: amountCents }],
    metadata: { order: externalId },
    customer: {
      name:  customerName,
      email: customerEmail,
      phone: customerPhone,
      document: {
        type:   "cpf",
        number: customerCpf,
      },
    },
  };

  const headers = {
    "Content-Type":  "application/json",
    "accept":        "application/json",
    "authorization": getAuthHeader(),
  };

  let resp;
  try {
    resp = await postWithRetry(`${SLIMMPAY_BASE}/payment-transaction/create`, payload, headers);
  } catch (err) {
    return jsonResponse(502, { success: false, error: "Falha ao conectar com gateway: " + String(err) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    return jsonResponse(resp.status, { success: false, error: text || "Erro ao criar cobrança PIX", raw: text });
  }

  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse(500, { success: false, error: "Resposta inválida da gateway", raw: text });
  }

  const data = parsed.data || parsed;

  // Campos retornados pelo Slimmpay
  const transactionId = data.id   || data.Id   || data.transaction_id || null;
  const pixCode       = data.pix?.qr_code || data.pix_code || data.brcode || data.qr_code || data.payload || null;
  const qrCodeImage   = data.pix?.qr_code_base64 || data.qr_code_base64 || data.qrCodeBase64 || null;

  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount:         amountReais,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_cpf:   customerCpf,
      customer_phone: customerPhone,
      status:         "PENDING",
      brcode:         pixCode,
    });
  } catch (_) {}

  return jsonResponse(200, {
    success:        true,
    pixCode,
    pix_code:       pixCode,
    brcode:         pixCode,
    payload:        pixCode,
    qr_code_image:  qrCodeImage,
    transaction_id: transactionId,
    transactionId,
    deposit_id:     transactionId,
    status:         data.Status || data.status || "PENDING",
  });
};
