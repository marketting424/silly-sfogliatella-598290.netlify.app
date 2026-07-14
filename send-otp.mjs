// soum v3.1 — build 1783977439
// إرسال رمز تحقق حقيقي لواتساب المستخدم
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TW_SID = process.env.TWILIO_ACCOUNT_SID;
  const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TW_FROM = process.env.TWILIO_WHATSAPP_FROM;
  if (!SB_URL || !SB_KEY || !TW_SID || !TW_TOKEN || !TW_FROM)
    return json({ error: 'missing_env' }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const phone = String(b.phone || '').replace(/\s/g, '');
  if (!/^05\d{8}$/.test(phone)) return json({ error: 'bad_phone' }, 400);

  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

  // محظور؟
  const blocked = await fetch(
    `${SB_URL}/rest/v1/soum_blocked_phones?phone=eq.${phone}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (Array.isArray(blocked) && blocked.length)
    return json({ error: 'blocked' }, 403);

  // متحقق منه سابقاً؟ ما يحتاج رمز
  const verified = await fetch(
    `${SB_URL}/rest/v1/soum_verified_phones?phone=eq.${phone}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (Array.isArray(verified) && verified.length)
    return json({ ok: true, alreadyVerified: true });

  // توليد رمز وحفظه (10 دقائق صلاحية)
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const up = await fetch(`${SB_URL}/rest/v1/soum_otp_codes?on_conflict=phone`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ phone, code, attempts: 0, expires_at: expires }),
  });
  if (!up.ok) return json({ error: 'db_fail' }, 502);

  // إرسال الرمز عبر واتساب
  const to = 'whatsapp:+966' + phone.slice(1);
  const auth = 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64');
  const tw = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: to, From: TW_FROM,
        Body: `🔐 رمز التحقق في سُوم: *${code}*\n\nصالح لمدة 10 دقائق — لا تشاركه مع أحد.`,
      }),
    }
  );
  const twData = await tw.json().catch(() => ({}));

  return json({
    ok: true,
    waSent: tw.ok,
    waError: tw.ok ? null : (twData.message || 'twilio_error'),
  });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
