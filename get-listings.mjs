// soum v3.1 — build 1783977439
// جلب الإعلانات النشطة من العرض العام الآمن (بدون أرقام جوالات)
export default async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json({ error: 'missing_env' }, 500);

  const res = await fetch(
    `${url}/rest/v1/soum_listings_public?select=*&order=created_at.desc&limit=60`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) return json({ error: 'db_error', detail: await res.text() }, 502);

  return json({ listings: await res.json() });
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
