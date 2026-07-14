// soum v3.1 — build 1783977439
// السومة: دمج المحادثة (مشتري + إعلان) + تسجيل السومة + إرسال واتساب حقيقي للبائع
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TW_SID = process.env.TWILIO_ACCOUNT_SID;
  const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TW_FROM = process.env.TWILIO_WHATSAPP_FROM; // مثال: whatsapp:+14155238886
  if (!SB_URL || !SB_KEY || !TW_SID || !TW_TOKEN || !TW_FROM)
    return json({ error: 'missing_env' }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const listingId = String(b.listingId || '');
  const amount = Math.round(+b.amount);
  const buyerName = String(b.name || '').trim();
  const buyerPhone = String(b.phone || '').replace(/\s/g, '');
  const note = String(b.message || '').trim();

  if (!/^[0-9a-f-]{36}$/.test(listingId)) return json({ error: 'bad_listing' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'bad_amount' }, 400);
  if (!buyerName) return json({ error: 'bad_name' }, 400);
  if (!/^05\d{8}$/.test(buyerPhone)) return json({ error: 'bad_phone' }, 400);

  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  const fmt = n => Number(n).toLocaleString('en-US');

  // محظور؟
  const blocked = await fetch(
    `${SB_URL}/rest/v1/soum_blocked_phones?phone=eq.${buyerPhone}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (Array.isArray(blocked) && blocked.length)
    return json({ error: 'blocked', message: 'هذا الرقم محظور من تقديم السومات' }, 403);

  // موثق؟ (حماية على مستوى السيرفر — الواجهة ما تنخدع)
  const isVerified = await fetch(
    `${SB_URL}/rest/v1/soum_verified_phones?phone=eq.${buyerPhone}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (!Array.isArray(isVerified) || !isVerified.length)
    return json({ error: 'unverified', message: 'تحقق من رقمك أولاً' }, 401);

  // الإعلان + بيانات البائع
  const lRes = await fetch(
    `${SB_URL}/rest/v1/soum_listings?id=eq.${listingId}&status=eq.active&select=id,title,price,soums_count,notify,soum_sellers(name,whatsapp,blocked)`,
    { headers: H }
  );
  const listings = lRes.ok ? await lRes.json() : [];
  if (!listings.length) return json({ error: 'not_found', message: 'الإعلان غير موجود' }, 404);
  const listing = listings[0];
  const seller = listing.soum_sellers;
  if (!seller || seller.blocked) return json({ error: 'not_found' }, 404);

  // المحادثة: وحدة لكل (مشتري + إعلان) — سومة ثانية = تحديث لا تكرار
  const cRes = await fetch(
    `${SB_URL}/rest/v1/soum_conversations?listing_id=eq.${listingId}&buyer_phone=eq.${buyerPhone}&select=id,conv_no,last_amount`,
    { headers: H }
  );
  const existing = cRes.ok ? await cRes.json() : [];
  let conv, isUpdate = false, prevAmount = null;

  if (existing.length) {
    conv = existing[0];
    isUpdate = true;
    prevAmount = conv.last_amount;
    await fetch(`${SB_URL}/rest/v1/soum_conversations?id=eq.${conv.id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ last_amount: amount, buyer_name: buyerName }),
    });
  } else {
    const ins = await fetch(`${SB_URL}/rest/v1/soum_conversations`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ listing_id: listingId, buyer_phone: buyerPhone, buyer_name: buyerName, last_amount: amount }),
    });
    if (!ins.ok) return json({ error: 'conv_fail', detail: await ins.text() }, 502);
    [conv] = await ins.json();
    // عداد السومات يزيد للسومة الجديدة فقط
    await fetch(`${SB_URL}/rest/v1/soum_listings?id=eq.${listingId}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ soums_count: (listing.soums_count || 0) + 1 }),
    });
  }

  // تسجيل السومة
  await fetch(`${SB_URL}/rest/v1/soum_offers`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ conversation_id: conv.id, amount, message: note || null }),
  });

  // نص رسالة الواتساب للبائع (نفس صيغة التصميم)
  const waBody = isUpdate
    ? `🔄 *${buyerName} عدّل سومته على إعلانك*\n\n📦 المنتج: ${listing.title}\n💰 السومة الجديدة: *${fmt(amount)} ريال* (كانت ${fmt(prevAmount || 0)})${note ? '\n💬 رسالته: ' + note : ''}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقمك يظل مخفي.\n\nمحادثة #${conv.conv_no} — سُوم`
    : `🔔 *سومة جديدة على إعلانك في سُوم*\n\n📦 المنتج: ${listing.title}${listing.price ? '\n🏷️ سعرك المطلوب: ' + fmt(listing.price) + ' ريال' : ''}\n💰 مبلغ السومة: *${fmt(amount)} ريال*\n👤 المشتري: ${buyerName}${note ? '\n💬 رسالته: ' + note : ''}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقمك يظل مخفي.\n\nمحادثة #${conv.conv_no} — سُوم`;

  // إرسال واتساب حقيقي عبر Twilio (لو البائع مفعّل الإشعارات)
  let waSent = false, waError = null;
  if (listing.notify !== false) {
    const to = 'whatsapp:+966' + seller.whatsapp.slice(1);
    const auth = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');
    const tw = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: TW_FROM, Body: waBody }),
      }
    );
    const twData = await tw.json().catch(() => ({}));
    waSent = tw.ok;
    if (!tw.ok) waError = twData.message || 'twilio_error';

    // توثيق الرسالة في السجل
    await fetch(`${SB_URL}/rest/v1/soum_messages`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        conversation_id: conv.id, direction: 'system',
        body: waBody, twilio_sid: twData.sid || null,
      }),
    });
  }

  return json({
    ok: true, convNo: conv.conv_no, isUpdate,
    prevAmount, waSent, waError,
    sellerName: seller.name,
  });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
