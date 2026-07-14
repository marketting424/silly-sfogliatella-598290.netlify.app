// soum v3.1 — build 1783977439
// نشر إعلان: upsert للبائع برقم واتسابه ثم إدراج الإعلان
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json({ error: 'missing_env' }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const title = String(b.title || '').trim();
  const whatsapp = String(b.whatsapp || '').replace(/\s/g, '');
  const category = String(b.category || 'misc');
  const city = String(b.city || 'الرياض');
  const price = Number.isFinite(+b.price) && +b.price > 0 ? Math.round(+b.price) : null;
  const desc = String(b.description || '').trim() || null;
  const sellerName = String(b.sellerName || 'بائع').trim() || 'بائع';
  const notify = b.notify !== false;

  if (title.length < 3 || title.length > 120) return json({ error: 'bad_title' }, 400);
  if (!/^05\d{8}$/.test(whatsapp)) return json({ error: 'bad_phone' }, 400);
  const CATS = ['phones','cars','furn','elec','animals','services','misc'];
  if (!CATS.includes(category)) return json({ error: 'bad_category' }, 400);

  const H = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  // محظور؟
  const blocked = await fetch(
    `${url}/rest/v1/soum_blocked_phones?phone=eq.${whatsapp}&select=phone`,
    { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (Array.isArray(blocked) && blocked.length)
    return json({ error: 'blocked', message: 'هذا الرقم محظور من النشر' }, 403);

  // موثق؟ (حماية على مستوى السيرفر — الواجهة ما تنخدع)
  const isVerified = await fetch(
    `${url}/rest/v1/soum_verified_phones?phone=eq.${whatsapp}&select=phone`, { headers: H }
  ).then(r => r.json()).catch(() => []);
  if (!Array.isArray(isVerified) || !isVerified.length)
    return json({ error: 'unverified', message: 'تحقق من رقمك أولاً' }, 401);

  // upsert البائع (المفتاح: رقم الواتساب)
  const sellerRes = await fetch(
    `${url}/rest/v1/soum_sellers?on_conflict=whatsapp`,
    {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ name: sellerName, whatsapp }),
    }
  );
  if (!sellerRes.ok) return json({ error: 'seller_fail', detail: await sellerRes.text() }, 502);
  const [seller] = await sellerRes.json();

  // إدراج الإعلان
  const listRes = await fetch(`${url}/rest/v1/soum_listings`, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({
      seller_id: seller.id, title, description: desc,
      category, city, price, notify, photos: [],
    }),
  });
  if (!listRes.ok) return json({ error: 'listing_fail', detail: await listRes.text() }, 502);
  const [listing] = await listRes.json();

  return json({ ok: true, id: listing.id });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
