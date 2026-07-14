// soum v3.1 — build 1783977439
// قلب القناة الوسيطة: استقبال ردود الواتساب وتمريرها للطرف الثاني
// التوجيه بثلاث طبقات: الرد بالسحب → #رقم المحادثة → آخر محادثة نشطة
export default async (req) => {
  if (req.method !== 'POST') return twiml('');
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TW_SID = process.env.TWILIO_ACCOUNT_SID;
  const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TW_FROM = process.env.TWILIO_WHATSAPP_FROM;
  if (!SB_URL || !SB_KEY || !TW_SID || !TW_TOKEN || !TW_FROM) return twiml('');

  // Twilio يرسل البيانات بصيغة form-urlencoded
  let form;
  try { form = await req.formData(); } catch { return twiml(''); }
  const rawFrom = String(form.get('From') || '');           // whatsapp:+9665XXXXXXXX
  const body = String(form.get('Body') || '').trim();
  const inSid = String(form.get('MessageSid') || '');
  const repliedSid = String(form.get('OriginalRepliedMessageSid') || '');

  // تطبيع الرقم: whatsapp:+9665XXXXXXXX → 05XXXXXXXX
  const m = rawFrom.match(/whatsapp:\+966(5\d{8})$/);
  if (!m || !body) return twiml('');
  const senderPhone = '0' + m[1];

  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  const SEL = 'id,conv_no,buyer_phone,buyer_name,last_amount,status,soum_listings!inner(title,soum_sellers!inner(whatsapp,name))';

  // محظور؟ نتجاهل بصمت
  const blocked = await fetch(
    `${SB_URL}/rest/v1/soum_blocked_phones?phone=eq.${senderPhone}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (Array.isArray(blocked) && blocked.length) return twiml('');

  // ===== الطبقة 1: الرد بالسحب — أدق توجيه ممكن =====
  let conv = null;
  if (repliedSid) {
    const msgRows = await fetch(
      `${SB_URL}/rest/v1/soum_messages?twilio_sid=eq.${repliedSid}&select=conversation_id`, { headers: H }
    ).then(r => r.json()).catch(() => []);
    if (msgRows.length) {
      const rows = await fetch(
        `${SB_URL}/rest/v1/soum_conversations?id=eq.${msgRows[0].conversation_id}&select=${SEL}`, { headers: H }
      ).then(r => r.json()).catch(() => []);
      conv = rows[0] || null;
    }
  }

  // ===== الطبقة 2: كتب #رقم المحادثة أول رسالته =====
  if (!conv) {
    const hash = body.match(/^#?(\d{4,})/);
    if (hash) {
      const rows = await fetch(
        `${SB_URL}/rest/v1/soum_conversations?conv_no=eq.${hash[1]}&select=${SEL}`, { headers: H }
      ).then(r => r.json()).catch(() => []);
      const c = rows[0];
      // لازم يكون طرفاً فيها
      if (c && (c.buyer_phone === senderPhone || c.soum_listings?.soum_sellers?.whatsapp === senderPhone))
        conv = c;
    }
  }

  // ===== الطبقة 3: آخر محادثة نشطة للمرسل (كمشتري أو كبائع) =====
  if (!conv) {
    const [asBuyer, asSeller] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/soum_conversations?buyer_phone=eq.${senderPhone}&order=updated_at.desc&limit=1&select=${SEL},updated_at`,
        { headers: H }).then(r => r.json()).catch(() => []),
      fetch(`${SB_URL}/rest/v1/soum_conversations?soum_listings.soum_sellers.whatsapp=eq.${senderPhone}&order=updated_at.desc&limit=1&select=${SEL},updated_at`,
        { headers: H }).then(r => r.json()).catch(() => []),
    ]);
    const candidates = [...asBuyer, ...asSeller].filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    conv = candidates[0] || null;
  }

  if (!conv) {
    return twiml('هلا! ما لقينا محادثة نشطة مرتبطة برقمك في سُوم.\nقدّم سومة من الموقع أول، أو ابدأ رسالتك برقم المحادثة (مثال: #1042).');
  }

  const seller = conv.soum_listings.soum_sellers;
  const title = conv.soum_listings.title;
  const senderIsBuyer = conv.buyer_phone === senderPhone;

  // منع التمرير الذاتي (يصير في الاختبار لما البائع = المشتري بنفس الرقم)
  if (senderIsBuyer && seller.whatsapp === senderPhone) {
    return twiml(`(وضع الاختبار) رقمك هو البائع والمشتري بنفس المحادثة #${conv.conv_no} — للتجربة الكاملة استخدم رقمين مختلفين مربوطين بالـ Sandbox.`);
  }

  const recipientPhone = senderIsBuyer ? seller.whatsapp : conv.buyer_phone;
  const direction = senderIsBuyer ? 'buyer_to_seller' : 'seller_to_buyer';
  const header = senderIsBuyer
    ? `💬 *رسالة من ${conv.buyer_name}* بخصوص «${title}»`
    : `💬 *رد البائع ${seller.name}* بخصوص «${title}»`;
  const fwdBody = `${header}\n\n${body}\n\n↩️ للرد: اسحب هذي الرسالة ورد عليها — رقم الطرف الثاني مخفي.\nمحادثة #${conv.conv_no} — سُوم`;

  // إرسال للطرف الثاني
  const auth = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');
  const tw = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: 'whatsapp:+966' + recipientPhone.slice(1),
        From: TW_FROM,
        Body: fwdBody,
      }),
    }
  );
  const twData = await tw.json().catch(() => ({}));

  // توثيق الرسالتين: الواردة (بمعرفها) والممررة (بمعرف الإرسال — للرد بالسحب لاحقاً)
  await fetch(`${SB_URL}/rest/v1/soum_messages`, {
    method: 'POST', headers: H,
    body: JSON.stringify([
      { conversation_id: conv.id, direction, body, twilio_sid: inSid || null, replied_to_sid: repliedSid || null },
      { conversation_id: conv.id, direction, body: fwdBody, twilio_sid: twData.sid || null },
    ]),
  });

  // لمس المحادثة لتحديث updated_at (يخدم توجيه "آخر محادثة نشطة")
  await fetch(`${SB_URL}/rest/v1/soum_conversations?id=eq.${conv.id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ buyer_name: conv.buyer_name }),
  });

  // رد TwiML فاضي = لا رد تلقائي من Sandbox، والتمرير تم بهدوء
  if (!tw.ok) {
    return twiml(`تعذر توصيل رسالتك للطرف الثاني (${twData.message || 'خطأ'}).\nفي مرحلة التجربة: لازم يكون رقمه مربوط بالـ Sandbox.`);
  }
  return twiml('');
};

// رد بصيغة TwiML — نص فاضي يعني "استلمنا، لا ترد بشي"
const twiml = (msg) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${escapeXml(msg)}</Message>` : ''}</Response>`,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' } }
  );

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
