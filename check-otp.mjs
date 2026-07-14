// soum v3.1 — build 1783977439
// التحقق من الرمز وتسجيل الرقم كموثق
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) return json({ error: 'missing_env' }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const phone = String(b.phone || '').replace(/\s/g, '');
  const code = String(b.code || '').trim();
  if (!/^05\d{8}$/.test(phone)) return json({ error: 'bad_phone' }, 400);
  if (!/^\d{4}$/.test(code)) return json({ error: 'bad_code_format' }, 400);

  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

  const rows = await fetch(
    `${SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}&select=*`, { headers: H }
  ).then(r => r.json()).catch(() => []);

  if (!Array.isArray(rows) || !rows.length)
    return json({ error: 'no_code', message: 'ما فيه رمز مرسل لهالرقم — اطلب رمز جديد' }, 400);

  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now())
    return json({ error: 'expired', message: 'الرمز انتهت صلاحيته — اطلب رمز جديد' }, 400);
  if (row.attempts >= 5)
    return json({ error: 'too_many', message: 'محاولات كثيرة — اطلب رمز جديد' }, 429);

  if (row.code !== code) {
    await fetch(`${SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ attempts: row.attempts + 1 }),
    });
    return json({ error: 'wrong_code', message: 'الرمز غير صحيح' }, 400);
  }

  // نجاح: توثيق الرقم وحذف الرمز
  await fetch(`${SB_URL}/rest/v1/soum_verified_phones?on_conflict=phone`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ phone }),
  });
  await fetch(`${SB_URL}/rest/v1/soum_otp_codes?phone=eq.${phone}`, {
    method: 'DELETE', headers: H,
  });

  return json({ ok: true });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
