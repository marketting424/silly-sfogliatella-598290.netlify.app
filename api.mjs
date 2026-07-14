// soum v3.2 — الدوال الست في ملف واحد (موجّه داخلي)
// المسارات: /api/get-listings /api/add-listing /api/send-soum /api/send-otp /api/check-otp /api/whatsapp-webhook /api/version
export const config = { path: "/api/*" };

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const env = {
    SB_URL: process.env.SUPABASE_URL,
    SB_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TW_SID: process.env.TWILIO_ACCOUNT_SID,
    TW_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TW_FROM: process.env.TWILIO_WHATSAPP_FROM,
  };
  try {
    if (route === "version")          return version(env);
    if (route === "get-listings")     return getListings(env);
    if (route === "add-listing")      return addListing(req, env);
    if (route === "send-soum")        return sendSoum(req, env);
    if (route === "send-otp")         return sendOtp(req, env);
    if (route === "check-otp")        return checkOtp(req, env);
    if (route === "whatsapp-webhook") return whatsappWebhook(req, env);
    return json({ error: "not_found", route }, 404);
  } catch (e) {
    console.error("api error on", route, e);
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
};

/* ==================== أدوات مشتركة ==================== */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const twiml = (msg) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${escapeXml(msg)}</Message>` : ""}</Response>`,
    { headers: { "Content-Type": "text/xml; charset=utf-8" } }
  );

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

const fmt = (n) => Number(n).toLocaleString("en-US");

const sb = (env) => ({
  apikey: env.SB_KEY,
  Authorization: `Bearer ${env.SB_KEY}`,
  "Content-Type": "application/json",
});

const isBlocked = async (env, phone) => {
  const r = await fetch(
    `${env.SB_URL}/rest/v1/soum_blocked_phones?phone=eq.${phone}&select=phone`,
    { headers: sb(env) }
  ).then((x) => x.json()).catch(() => []);
  return Array.isArray(r) && r.length > 0;
};

const isVerified = async (env, phone) => {
  const r = await fetch(
    `${env.SB_URL}/rest/v1/soum_verified_phones?phone=eq.${phone}&select=phone`,
    { headers: sb(env) }
  ).then((x) => x.json()).catch(() => []);
  return Array.isArray(r) && r.length > 0;
};

const sendWhatsApp = async (env, phone05, body) => {
  const auth = "Basic " + Buffer.from(`${env.TW_SID}:${env.TW_TOKEN}`).toString("base64");
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TW_SID}/Messages.json`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: "whatsapp:+966" + phone05.slice(1),
        From: env.TW_FROM,
        Body: body,
      }),
    }
  );
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, sid: data.sid || null, error: r.ok ? null : data.message || "twilio_error" };
};

/* ==================== version ==================== */
function version(env) {
  return json({
    version: "v3.2-unified",
    env_ok: {
      supabase: !!(env.SB_URL && env.SB_KEY),
      twilio: !!(env.TW_SID && env.TW_TOKEN && env.TW_FROM),
    },
    time: new Date().toISOString(),
  });
}

/* ==================== get-listings ==================== */
async function getListings(env) {
  if (!env.SB_URL || !env.SB_KEY) return json({ error: "missing_env" }, 500);
  const res = await fetch(
    `${env.SB_URL}/rest/v1/soum_listings_public?select=*&order=created_at.desc&limit=60`,
    { headers: sb(env) }
  );
  if (!res.ok) return json({ error: "db_error", detail: await res.text() }, 502);
  return json({ listings: await res.json() });
}

/* ==================== add-listing ==================== */
async function addListing(req, env) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.SB_URL || !env.SB_KEY) return json({ error: "missing_env" }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const title = String(b.title || "").trim();
  const whatsapp = String(b.whatsapp || "").replace(/\s/g, "");
  const category = String(b.category || "misc");
  const city = String(b.city || "الرياض");
  const price = Number.isFinite(+b.price) && +b.price > 0 ? Math.round(+b.price) : null;
  const desc = String(b.description || "").trim() || null;
  const sellerName = String(b.sellerName || "بائع").trim() || "بائع";
  const notify = b.notify !== false;

  if (title.length < 3 || title.length > 120) return json({ error: "bad_title" }, 400);
  if (!/^05\d{8}$/.test(whatsapp)) return json({ error: "bad_phone" }, 400);
  const CATS = ["phones", "cars", "furn", "elec", "animals", "services", "misc"];
  if (!CATS.includes(category)) return json({ error: "bad_category" }, 400);

  if (await isBlocked(env, whatsapp))
    return json({ error: "blocked", message: "هذا الرقم محظور من النشر" }, 403);
  if (!(await isVerified(env, whatsapp)))
    return json({ error: "unverified", message: "تحقق من رقمك أولاً" }, 401);

  const sellerRes = await fetch(`${env.SB_URL}/rest/v1/soum_sellers?on_conflict=whatsapp`, {
    method: "POST",
    headers: { ...sb(env), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ name: sellerName, whatsapp }),
  });
  if (!sellerRes.ok) return json({ error: "seller_fail", detail: await sellerRes.text() }, 502);
  const [seller] = await sellerRes.json();

  const listRes = await fetch(`${env.SB_URL}/rest/v1/soum_listings`, {
    method: "POST",
    headers: { ...sb(env), Prefer: "return=representation" },
    body: JSON.stringify({
      seller_id: seller.id, title, description: desc,
      category, city, price, notify, photos: [],
    }),
  });
  if (!listRes.ok) return json({ error: "listing_fail", detail: await listRes.text() }, 502);
  const [listing] = await listRes.json();
  return json({ ok: true, id: listing.id });
}

/* ==================== send-soum ==================== */
async function sendSoum(req, env) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.SB_URL || !env.SB_KEY || !env.TW_SID || !env.TW_TOKEN || !env.TW_FROM)
    return json({ error: "missing_env" }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const listingId = String(b.listingId || "");
  const amount = Math.round(+b.amount);
  const buyerName = String(b.name || "").trim();
  const buyerPhone = String(b.phone || "").replace(/\s/g, "");
  const note = String(b.message || "").trim();

  if (!/^[0-9a-f-]{36}$/.test(listingId)) return json({ error: "bad_listing" }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "bad_amount" }, 400);
  if (!buyerName) return json({ error: "bad_name" }, 400);
  if (!/^05\d{8}$/.test(buyerPhone)) return json({ error: "bad_phone" }, 400);

  if (await isBlocked(env, buyerPhone))
    return json({ error: "blocked", message: "هذا الرقم محظور من تقديم السومات" }, 403);
  if (!(await isVerified(env, buyerPhone)))
    return json({ error: "unverified", message: "تحقق من رقمك أولاً" }, 401);

  const H = sb(env);
  const lRes = await fetch(
    `${env.SB_URL}/rest/v1/soum_listings?id=eq.${listingId}&status=eq.active&select=id,title,price,soums_count,notify,soum_sellers(name,whatsapp,blocked)`,
    { headers: H }
  );
  const listings = lRes.ok ? await lRes.json() : [];
  if (!listings.length) return json({ error: "not_found", message: "الإعلان غير موجود" }, 404);
  const listing = listings[0];
  const seller = listing.soum_sellers;
  if (!seller || seller.blocked) return json({ error: "not_found" }, 404);

  const cRes = await fetch(
    `${env.SB_URL}/rest/v1/soum_conversations?listing_id=eq.${listingId}&buyer_phone=eq.${buyerPhone}&select=id,conv_no,last_amount`,
    { headers: H }
  );
  const existing = cRes.ok ? await cRes.json() : [];
  let conv, isUpdate = false, prevAmount = null;

  if (existing.length) {
    conv = existing[0];
    isUpdate = true;
    prevAmount = conv.last_amount;
    await fetch(`${env.SB_URL}/rest/v1/soum_conversations?id=eq.${conv.id}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ last_amount: amount, buyer_name: buyerName }),
    });
  } else {
    const ins = await fetch(`${env.SB_URL}/rest/v1/soum_conversations`, {
      method: "POST", headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ listing_id: listingId, buyer_phone: buyerPhone, buyer_name: buyerName, last_amount: amount }),
    });
    if (!ins.ok) return json({ error: "conv_fail", detail: await ins.text() }, 502);
    [conv] = await ins.json();
    await fetch(`${env.SB_URL}/rest/v1/soum_listings?id=eq.${listingId}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ soums_count: (listing.soums_count || 0) + 1 }),
    });
  }

  await fetch(`${env.SB_URL}/rest/v1/soum_offers`, {
    method: "POST", headers: H,
    body: JSON.stringify({ conversation_id: conv.id, amount, message: note || null }),
  });

  const waBody = isUpdate
    ? `🔄 *${buyerName} عدّل سومته على إعلانك*\n\n📦 المنتج: ${listing.title}\n💰 السومة الجديدة: *${fmt(amount)} ريال* (كانت ${fmt(prevAmount || 0)})${note ? "\n💬 رسالته: " + note : ""}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقمك يظل مخفي.\n\nمحادثة #${conv.conv_no} — سُوم`
    : `🔔 *سومة جديدة على إعلانك في سُوم*\n\n📦 المنتج: ${listing.title}${listing.price ? "\n🏷️ سعرك المطلوب: " + fmt(listing.price) + " ريال" : ""}\n💰 مبلغ السومة: *${fmt(amount)} ريال*\n👤 المشتري: ${buyerName}${note ? "\n💬 رسالته: " + note : ""}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقمك يظل مخفي.\n\nمحادثة #${conv.conv_no} — سُوم`;

  let waSent = false, waError = null;
  if (listing.notify !== false) {
    const tw = await sendWhatsApp(env, seller.whatsapp, waBody);
    waSent = tw.ok;
    waError = tw.error;
    await fetch(`${env.SB_URL}/rest/v1/soum_messages`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        conversation_id: conv.id, direction: "system",
        body: waBody, twilio_sid: tw.sid,
      }),
    });
  }

  return json({ ok: true, convNo: conv.conv_no, isUpdate, prevAmount, waSent, waError, sellerName: seller.name });
}

/* ==================== send-otp ==================== */
async function sendOtp(req, env) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.SB_URL || !env.SB_KEY || !env.TW_SID || !env.TW_TOKEN || !env.TW_FROM)
    return json({ error: "missing_env" }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const phone = String(b.phone || "").replace(/\s/g, "");
  if (!/^05\d{8}$/.test(phone)) return json({ error: "bad_phone" }, 400);

  if (await isBlocked(env, phone)) return json({ error: "blocked" }, 403);
  if (await isVerified(env, phone)) return json({ ok: true, alreadyVerified: true });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const up = await fetch(`${env.SB_URL}/rest/v1/soum_otp_codes?on_conflict=phone`, {
    method: "POST",
    headers: { ...sb(env), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ phone, code, attempts: 0, expires_at: expires }),
  });
  if (!up.ok) return json({ error: "db_fail" }, 502);

  const tw = await sendWhatsApp(env, phone,
    `🔐 رمز التحقق في سُوم: *${code}*\n\nصالح لمدة 10 دقائق — لا تشاركه مع أحد.`);

  return json({ ok: true, waSent: tw.ok, waError: tw.error });
}

/* ==================== check-otp ==================== */
async function checkOtp(req, env) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.SB_URL || !env.SB_KEY) return json({ error: "missing_env" }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const phone = String(b.phone || "").replace(/\s/g, "");
  const code = String(b.code || "").trim();
  if (!/^05\d{8}$/.test(phone)) return json({ error: "bad_phone" }, 400);
  if (!/^\d{4}$/.test(code)) return json({ error: "bad_code_format" }, 400);

  const H = sb(env);
  const rows = await fetch(
    `${env.SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}&select=*`, { headers: H }
  ).then((r) => r.json()).catch(() => []);

  if (!Array.isArray(rows) || !rows.length)
    return json({ error: "no_code", message: "ما فيه رمز مرسل لهالرقم — اطلب رمز جديد" }, 400);

  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now())
    return json({ error: "expired", message: "الرمز انتهت صلاحيته — اطلب رمز جديد" }, 400);
  if (row.attempts >= 5)
    return json({ error: "too_many", message: "محاولات كثيرة — اطلب رمز جديد" }, 429);

  if (row.code !== code) {
    await fetch(`${env.SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ attempts: row.attempts + 1 }),
    });
    return json({ error: "wrong_code", message: "الرمز غير صحيح" }, 400);
  }

  await fetch(`${env.SB_URL}/rest/v1/soum_verified_phones?on_conflict=phone`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ phone }),
  });
  await fetch(`${env.SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}`, {
    method: "DELETE", headers: H,
  });
  return json({ ok: true });
}

/* ==================== whatsapp-webhook ==================== */
async function whatsappWebhook(req, env) {
  if (req.method !== "POST") return twiml("");
  if (!env.SB_URL || !env.SB_KEY || !env.TW_SID || !env.TW_TOKEN || !env.TW_FROM) return twiml("");

  let form;
  try { form = await req.formData(); } catch { return twiml(""); }
  const rawFrom = String(form.get("From") || "");
  const body = String(form.get("Body") || "").trim();
  const inSid = String(form.get("MessageSid") || "");
  const repliedSid = String(form.get("OriginalRepliedMessageSid") || "");

  const m = rawFrom.match(/whatsapp:\+966(5\d{8})$/);
  if (!m || !body) return twiml("");
  const senderPhone = "0" + m[1];

  if (await isBlocked(env, senderPhone)) return twiml("");

  const H = sb(env);
  const SEL = "id,conv_no,buyer_phone,buyer_name,last_amount,status,soum_listings!inner(title,soum_sellers!inner(whatsapp,name))";

  let conv = null;
  if (repliedSid) {
    const msgRows = await fetch(
      `${env.SB_URL}/rest/v1/soum_messages?twilio_sid=eq.${repliedSid}&select=conversation_id`, { headers: H }
    ).then((r) => r.json()).catch(() => []);
    if (msgRows.length) {
      const rows = await fetch(
        `${env.SB_URL}/rest/v1/soum_conversations?id=eq.${msgRows[0].conversation_id}&select=${SEL}`, { headers: H }
      ).then((r) => r.json()).catch(() => []);
      conv = rows[0] || null;
    }
  }

  if (!conv) {
    const hash = body.match(/^#?(\d{4,})/);
    if (hash) {
      const rows = await fetch(
        `${env.SB_URL}/rest/v1/soum_conversations?conv_no=eq.${hash[1]}&select=${SEL}`, { headers: H }
      ).then((r) => r.json()).catch(() => []);
      const c = rows[0];
      if (c && (c.buyer_phone === senderPhone || c.soum_listings?.soum_sellers?.whatsapp === senderPhone))
        conv = c;
    }
  }

  if (!conv) {
    const [asBuyer, asSeller] = await Promise.all([
      fetch(`${env.SB_URL}/rest/v1/soum_conversations?buyer_phone=eq.${senderPhone}&order=updated_at.desc&limit=1&select=${SEL},updated_at`,
        { headers: H }).then((r) => r.json()).catch(() => []),
      fetch(`${env.SB_URL}/rest/v1/soum_conversations?soum_listings.soum_sellers.whatsapp=eq.${senderPhone}&order=updated_at.desc&limit=1&select=${SEL},updated_at`,
        { headers: H }).then((r) => r.json()).catch(() => []),
    ]);
    const candidates = [...asBuyer, ...asSeller].filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    conv = candidates[0] || null;
  }

  if (!conv) {
    return twiml("هلا! ما لقينا محادثة نشطة مرتبطة برقمك في سُوم.\nقدّم سومة من الموقع أول، أو ابدأ رسالتك برقم المحادثة (مثال: #1042).");
  }

  const seller = conv.soum_listings.soum_sellers;
  const title = conv.soum_listings.title;
  const senderIsBuyer = conv.buyer_phone === senderPhone;

  if (senderIsBuyer && seller.whatsapp === senderPhone) {
    return twiml(`(وضع الاختبار) رقمك هو البائع والمشتري بنفس المحادثة #${conv.conv_no} — للتجربة الكاملة استخدم رقمين مختلفين مربوطين بالـ Sandbox.`);
  }

  const recipientPhone = senderIsBuyer ? seller.whatsapp : conv.buyer_phone;
  const direction = senderIsBuyer ? "buyer_to_seller" : "seller_to_buyer";
  const header = senderIsBuyer
    ? `💬 *رسالة من ${conv.buyer_name}* بخصوص «${title}»`
    : `💬 *رد البائع ${seller.name}* بخصوص «${title}»`;
  const fwdBody = `${header}\n\n${body}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقم الطرف الثاني مخفي.\nمحادثة #${conv.conv_no} — سُوم`;

  const tw = await sendWhatsApp(env, recipientPhone, fwdBody);

  await fetch(`${env.SB_URL}/rest/v1/soum_messages`, {
    method: "POST", headers: H,
    body: JSON.stringify([
      { conversation_id: conv.id, direction, body, twilio_sid: inSid || null, replied_to_sid: repliedSid || null },
      { conversation_id: conv.id, direction, body: fwdBody, twilio_sid: tw.sid },
    ]),
  });

  await fetch(`${env.SB_URL}/rest/v1/soum_conversations?id=eq.${conv.id}`, {
    method: "PATCH", headers: H,
    body: JSON.stringify({ buyer_name: conv.buyer_name }),
  });

  if (!tw.ok) {
    return twiml(`تعذر توصيل رسالتك للطرف الثاني (${tw.error || "خطأ"}).\nفي مرحلة التجربة: لازم يكون رقمه مربوط بالـ Sandbox.`);
  }
  return twiml("");
}
