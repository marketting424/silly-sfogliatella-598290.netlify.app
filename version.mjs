// soum v3.1 — دالة تشخيص
export default async () =>
  new Response(JSON.stringify({
    version: 'v3.1',
    functions_expected: ['get-listings','add-listing','send-soum','send-otp','check-otp','whatsapp-webhook','version'],
    time: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
