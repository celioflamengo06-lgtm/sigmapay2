const { getSupabase } = require("./lib/supabase");

const POSEIDON_BASE       = "https://app.poseidonpay.site/api/v1/gateway/pix/receive";
const POSEIDON_PUBLIC_KEY = process.env.POSEIDON_PUBLIC_KEY;
const POSEIDON_SECRET_KEY = process.env.POSEIDON_SECRET_KEY;

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
  if (rawAmount == null) return 39.70;
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return 39.70;
  if (!Number.isInteger(n)) return n;
  if (n < 100) return n;
  return n / 100;
}

function gerarCpfValido() {
  const n = () => Math.floor(Math.random() * 9);
  const d = Array.from({ length: 9 }, n);
  let s1 = d.reduce((a, v, i) => a + v * (10 - i), 0);
  let r1 = (s1 * 10) % 11; if (r1 >= 10) r1 = 0;
  d.push(r1);
  let s2 = d.reduce((a, v, i) => a + v * (11 - i), 0);
  let r2 = (s2 * 10) % 11; if (r2 >= 10) r2 = 0;
  d.push(r2);
  return d.join('');
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
  } catch { body = {}; }

  const randDigits = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
  const randId = randDigits(6);

  const rawAmount   = body.amount ?? body.valor ?? body.total ?? 39.70;
  const amountReais = normalizeAmount(rawAmount);

  const customerName  = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@gmail.com`).toString().trim();
  const rawPhone      = (body.phone || body.customer_phone || `11${randDigits(9)}`).toString().replace(/\D/g, "");
  const customerPhone = `(${rawPhone.slice(0,2)}) ${rawPhone.slice(2,7)}-${rawPhone.slice(7,11)}`;
  const cpfRaw        = (body.cpf || body.document || body.customer_cpf || "").toString().replace(/\D/g, "");
  const customerCpf   = cpfRaw.length === 11 ? cpfRaw : gerarCpfValido();

  const identifier = `pedido-${randId}-${Date.now()}`;
  const dueDate    = new Date(Date.now() + 86400000).toISOString().split("T")[0];

  const payload = {
    identifier,
    amount:   amountReais,
    dueDate,
    client: {
      name:     customerName,
      email:    customerEmail,
      phone:    customerPhone,
      document: customerCpf,
    },
    products: [{
      id:       "livro-falante-001",
      name:     "Livro Falante",
      quantity: 1,
      price:    amountReais,
    }],
  };

  const headers = {
    "Content-Type":  "application/json",
    "x-public-key":  POSEIDON_PUBLIC_KEY,
    "x-secret-key":  POSEIDON_SECRET_KEY,
  };

  let resp;
  try {
    resp = await postWithRetry(POSEIDON_BASE, payload, headers);
  } catch (err) {
    return jsonResponse(502, { success: false, error: "Falha ao conectar com gateway: " + String(err) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    return jsonResponse(resp.status, { success: false, error: text || "Erro ao criar cobrança PIX", raw: text });
  }

  let data = {};
  try { data = JSON.parse(text); } catch {
    return jsonResponse(500, { success: false, error: "Resposta inválida da gateway", raw: text });
  }

  // Poseidon retorna: transactionId, pix.code, pix.base64
  const transactionId = data.transactionId || data.order?.id || null;
  const pixCode       = data.pix?.code || null;
  const qrCodeImage   = data.pix?.base64 || data.pix?.image || null;

  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount:         amountReais,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_cpf:   customerCpf,
      customer_phone: rawPhone,
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
    status:         data.status || "PENDING",
  });
};
