// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { company_code } = await req.json();
    if (!company_code) return json({ success: false, error: 'company_code required' }, 400);

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Verify tenant exists and is active
    const { data: tenant } = await adminClient
      .from('tenants')
      .select('id, is_active')
      .ilike('company_code', company_code)
      .single();

    if (!tenant || !tenant.is_active) {
      return json({ success: false, error: 'Invalid company code' }, 403);
    }

    const { data: tickets, error } = await adminClient
      .from('support_tickets')
      .select('id, subject, status, priority, category, created_at, admin_reply, replied_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    return json({ success: true, tickets: tickets || [] });

  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
});